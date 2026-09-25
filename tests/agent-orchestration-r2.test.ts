import {afterEach,describe,expect,it,vi} from "vitest";
import {createHash} from "node:crypto";
import {AgentToolSession,type Operation,type ToolCall,type SessionLimits} from "../src/agent-orchestration.js";
import type {ProgressEvent} from "../src/orchestration/progress.js";

const ok=(result:Record<string,unknown>={done:true})=>({ok:true,result});
const denied=()=>({ok:false,error:{code:"BACKEND_POLICY",retryable:false}});
const op=(id:string,extra:Partial<Operation>={}):Operation=>({id,subtask:"workflow",intent:id,target:"fixture",authorization:"a",mutating:false,call:{name:"host_stat",arguments:{}},...extra});
const sessions:AgentToolSession[]=[];
function fixture(dispatch:(call:ToolCall)=>Promise<unknown>=async()=>ok(),limits:Partial<SessionLimits>={},onEvent?:(event:ProgressEvent)=>void) {
  let now=0;const events:ProgressEvent[]=[];const spy=vi.fn(dispatch);
  const verifyChange=vi.fn(async()=>true);
  const session=new AgentToolSession({dispatch:spy,availableTools:new Set(["host_stat","host_read_file","host_read_many","host_diagnostics_batch","host_process_start","host_process_output"]),onEvent:onEvent??(e=>events.push(e)),limits,verifyChange,now:()=>now});
  sessions.push(session);return {session,spy,events,verifyChange,advance:(ms:number)=>{now+=ms;session.progress.tick();}};
}
function deferred() {let resolve!:(value:unknown)=>void;const promise=new Promise<unknown>(r=>{resolve=r;});return {promise,resolve};}
afterEach(()=>{sessions.splice(0).forEach(s=>s.close());vi.restoreAllMocks();});
const files=[{path:"a",length:1},{path:"b",length:1}];
const reads=()=>ok({files:files.map(f=>({...f,content:"x"}))});

describe("R2 H1 read batch admission",()=>{
  it("full in-flight capacity does not create member failures and recovers",async()=>{
    const hold=deferred();const {session,spy}=fixture(async call=>call.name==="host_read_many"?reads():hold.promise,{in_flight:1});
    const occupied=session.execute(op("occupied"));await Promise.resolve();
    const result=await session.readFiles(op("read",{intent:"read"}),files,true);
    expect(result).toEqual(files.map(()=>({status:"suppressed",reason:"WORKFLOW_CAPACITY:in_flight"})));
    expect(spy.mock.calls.filter(([c])=>c.name==="host_read_many")).toHaveLength(0);
    expect(session.snapshot().history_intents).toBe(1);
    hold.resolve(ok());await occupied;
    expect((await session.readFiles(op("retry",{intent:"read"}),files,true)).map(x=>x.status)).toEqual(["succeeded","succeeded"]);
    expect(session.snapshot().history_intents).toBe(0);
  });
  it("full event queue suppresses with zero dispatches until drain",async()=>{
    let fail=true;const {session,spy}=fixture(async()=>reads(),{event_queue:1},()=>{if(fail)throw new Error("sink unavailable");});
    session.progress.lane("setup","setup","setup");session.progress.event("setup",{type:"attempt"});
    expect(await session.readFiles(op("read",{intent:"read"}),files,true)).toEqual(files.map(()=>({status:"suppressed",reason:"WORKFLOW_CAPACITY:event_queue"})));
    expect(spy).not.toHaveBeenCalled();expect(session.snapshot().history_intents).toBe(0);
    fail=false;session.progress.drainUndelivered();
    expect((await session.readFiles(op("retry",{intent:"read"}),files,true)).map(x=>x.status)).toEqual(["succeeded","succeeded"]);
    expect(spy).toHaveBeenCalledTimes(1);
  });
  it("capacity consumed between member reservation and aggregate admission releases every reservation",async()=>{
    const hold=deferred();const {session,spy}=fixture(async call=>call.name==="host_read_many"?reads():hold.promise,{in_flight:1});
    const execute=session.execute.bind(session);let occupied:Promise<unknown>|undefined;
    vi.spyOn(session,"execute").mockImplementation(operation=>{
      if(operation.call.name==="host_read_many"&&!occupied){expect(session.snapshot().active_intents).toBe(2);occupied=execute(op("occupied"));}
      return execute(operation);
    });
    expect((await session.readFiles(op("read",{intent:"read"}),files,true)).every(x=>x.reason==="WORKFLOW_CAPACITY:in_flight")).toBe(true);
    expect(spy.mock.calls.filter(([c])=>c.name==="host_read_many")).toHaveLength(0);
    expect(session.snapshot().active_intents).toBe(1);
    hold.resolve(ok());await occupied;
    expect((await session.readFiles(op("retry",{intent:"read"}),files,true)).every(x=>x.status==="succeeded")).toBe(true);
  });
});

const diagnosticMembers=[
  {tool:"stat",args:{path:"a"},identity:{intent:"inspect",target:"a"}},
  {tool:"stat",args:{path:"b"},identity:{intent:"inspect",target:"b"}}
];
const partial=()=>ok({operations:[denied(),ok({size:1})],failed:1,succeeded:1});
describe("R2 H2 diagnostic member history",()=>{
  it("partial denial survives new IDs, a singleton and an alternate executor; successful B remains usable",async()=>{
    const {session,spy}=fixture(async()=>partial());
    expect((await session.diagnostics(op("batch"),diagnosticMembers)).map(x=>[x.status,x.errorClass])).toEqual([["failed","BACKEND_POLICY"],["succeeded",undefined]]);
    expect((await session.execute(op("single",{intent:"inspect",target:"a"}))).reason).toBe("EQUIVALENT_RETRY");
    expect((await session.execute(op("alternate",{intent:"inspect",target:"a",call:{name:"host_read_file",arguments:{path:"a"}}}))).reason).toBe("EQUIVALENT_RETRY");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0].arguments.operations).toEqual(diagnosticMembers.map(({tool,args})=>({tool,args})));
    spy.mockResolvedValue(ok({operations:[ok({size:1})],succeeded:1,failed:0}));
    const retried=await session.diagnostics(op("second-batch"),diagnosticMembers);
    expect(retried.map(x=>x.status)).toEqual(["suppressed","succeeded"]);
    expect(retried[0].reason).toBe("EQUIVALENT_RETRY");expect(spy).toHaveBeenCalledTimes(2);
    expect(session.snapshot().history_intents).toBeGreaterThanOrEqual(1);
  });
  it("verified new authorization uses the same retry contract and a second denial closes the path",async()=>{
    const {session,spy,verifyChange}=fixture(async()=>partial());
    await session.diagnostics(op("batch"),diagnosticMembers);
    spy.mockResolvedValue(ok({operations:[denied()],failed:1}));
    const changed=op("approved",{authorization:"b",change:{kind:"approval",evidenceId:"new-approval"}});
    expect((await session.diagnostics(changed,[diagnosticMembers[0]]))[0]).toMatchObject({status:"failed",errorClass:"BACKEND_POLICY"});
    expect(verifyChange).toHaveBeenCalledWith(expect.objectContaining({intent:"inspect",target:"a",authorization:"b"}),{authorization:"a",failure:"BACKEND_POLICY"});
    expect((await session.execute(op("again",{intent:"inspect",target:"a",authorization:"c",change:{kind:"approval",evidenceId:"another"}}))).reason).toBe("EQUIVALENT_RETRY");
    expect(spy).toHaveBeenCalledTimes(2);
  });
  it("a verified capability change can recover the denied member",async()=>{
    const {session,spy}=fixture(async()=>partial());await session.diagnostics(op("batch"),diagnosticMembers);
    spy.mockResolvedValue(ok({operations:[ok({size:1})],failed:0}));
    expect((await session.diagnostics(op("recovered",{change:{kind:"capability",evidenceId:"capability-restored"}}),[diagnosticMembers[0]]))[0].status).toBe("succeeded");
    expect(spy).toHaveBeenCalledTimes(2);
  });
  it("overlapping batches reserve member identity before either dispatch completes",async()=>{
    const hold=deferred();const {session,spy}=fixture(()=>hold.promise);
    const first=session.diagnostics(op("first"),diagnosticMembers);await Promise.resolve();
    const second=await session.diagnostics(op("second"),[diagnosticMembers[0]]);
    expect(second[0]).toMatchObject({status:"suppressed",reason:"INTENT_IN_FLIGHT"});
    expect(spy).toHaveBeenCalledTimes(1);hold.resolve(partial());await first;
    expect(session.snapshot().active_intents).toBe(0);
    expect((await session.execute(op("after",{intent:"inspect",target:"a"}))).reason).toBe("EQUIVALENT_RETRY");
  });
  it("transport failure of the aggregate does not invent individual policy denials",async()=>{
    const {session,spy}=fixture(async()=>{throw Object.assign(new Error("lost response"),{code:"ETIMEDOUT"});});
    expect((await session.diagnostics(op("batch"),diagnosticMembers)).every(x=>x.errorClass==="TRANSPORT")).toBe(true);
    expect(session.snapshot().active_intents).toBe(0);
    spy.mockResolvedValue(ok());
    expect((await session.execute(op("member",{intent:"inspect",target:"a"}))).status).toBe("succeeded");
  });
});

const job=(id:string)=>op(id,{mutating:true,longRunning:true,jobStart:{name:"host_process_start",arguments:{label:id}}});
describe("R2 H3 terminal BLOCKED jobs",()=>{
  it("finalizes BLOCKED, releases capacity, keeps failure history and suppresses dependent children",async()=>{
    const {session,spy,advance}=fixture(async call=>call.name==="host_process_output"?ok({job_id:"job",status:"BLOCKED"}):ok({job_id:"job",status:"running"}),{jobs:1});
    expect((await session.execute(job("start"))).status).toBe("running");advance(5_000);
    expect(await session.poll("start")).toMatchObject({status:"failed",errorClass:"EXPECTED_REVIEW_BLOCKED"});
    expect(session.snapshot()).toMatchObject({jobs:[],active_intents:0,history_intents:1,ambiguous_intents:[]});
    expect((await session.poll("start")).reason).toBe("UNKNOWN_JOB");
    expect((await session.execute(op("child",{dependsOn:["start"]}))).reason).toBe("DEPENDENCY_NOT_SUCCESSFUL");
    expect((await session.execute(job("start")))).toMatchObject({status:"failed",errorClass:"EXPECTED_REVIEW_BLOCKED",result_retained:false});
    expect((await session.execute({...job("retry"),intent:"start"})).reason).toBe("EQUIVALENT_RETRY");
    expect((await session.execute(job("independent"))).status).toBe("running");expect(spy).toHaveBeenCalledTimes(3);
  });
  it("multiple BLOCKED jobs release all slots and unpause progress",async()=>{
    const {session,advance,events}=fixture(async call=>call.name==="host_process_output"?ok({job_id:call.arguments.job_id,status:"BLOCKED"}):ok({job_id:call.arguments.label,status:"running"}),{jobs:3});
    for(let i=0;i<3;i++)await session.execute({...job(String(i)),subtask:String(i)});
    advance(5_000);expect((await Promise.all(["0","1","2"].map(id=>session.poll(id)))).every(x=>x.status==="failed")).toBe(true);
    expect(session.snapshot()).toMatchObject({jobs:[],active_intents:0,history_intents:3});
    advance(300_000);expect(events.filter(e=>e.type==="status_update")).toHaveLength(3);
    expect((await session.execute(job("replacement"))).status).toBe("running");
  });
  it("a matching BLOCKED result clears prior observation ambiguity",async()=>{
    const {session,spy,advance}=fixture(async()=>ok({job_id:"job",status:"running"}));
    await session.execute(job("start"));advance(5_000);
    spy.mockResolvedValue(ok({job_id:"wrong-job",status:"BLOCKED"}));
    expect((await session.poll("start")).status).toBe("ambiguous");expect(session.snapshot().jobs).toHaveLength(1);
    expect(session.snapshot().ambiguous_intents).toHaveLength(1);advance(10_000);
    spy.mockResolvedValue(ok({job_id:"job",status:"BLOCKED"}));
    expect((await session.poll("start")).status).toBe("failed");expect(session.snapshot().ambiguous_intents).toHaveLength(0);
  });
  it("BLOCKED arriving after close finalizes the admitted observation without child success",async()=>{
    const hold=deferred();const {session,spy,advance}=fixture(async call=>call.name==="host_process_output"?hold.promise:ok({job_id:"job",status:"running"}));
    await session.execute(job("start"));advance(5_000);const polling=session.poll("start");session.close();
    expect(session.snapshot().state).toBe("closing");hold.resolve(ok({job_id:"job",status:"BLOCKED"}));
    expect((await polling).status).toBe("failed");expect(session.snapshot()).toMatchObject({state:"closed",jobs:[],active_intents:0,history_intents:1});
    expect((await session.execute(op("child",{dependsOn:["start"]}))).reason).toBe("SESSION_CLOSED");expect(spy).toHaveBeenCalledTimes(2);
  });
});

const digest=(value:string)=>createHash("sha256").update(value).digest("hex");
describe("R2 medium progress identity",()=>{
  it("a later block carries B's effect/target and lane reuse does not reset active time",async()=>{
    const {session,spy,events,advance}=fixture();await session.execute(op("a",{target:"target-a"}));advance(200_000);
    spy.mockResolvedValue(denied());await session.execute(op("b",{target:"target-b"}));advance(100_000);
    expect(events.find(e=>e.type==="blocker")).toMatchObject({intent:digest("b"),target:digest("target-b")});
    expect(events.filter(e=>e.type==="status_update")).toHaveLength(1);
  });
  it("a late A failure is not attributed to B admitted on the same lane",async()=>{
    const hold=deferred();const {session,spy,events}=fixture(()=>hold.promise);
    const first=session.execute(op("a",{target:"target-a"}));await Promise.resolve();
    spy.mockResolvedValue(ok());await session.execute(op("b",{target:"target-b"}));hold.resolve(denied());await first;
    expect(events.find(e=>e.type==="blocker")).toMatchObject({intent:digest("a"),target:digest("target-a")});
  });
});

describe("R2 additional batch races",()=>{
  it("fresh batch member validation completes before its dependent child can dispatch",async()=>{
    const {session,spy}=fixture(async()=>ok({operations:[ok({})],failed:0}));
    const batch=session.diagnostics(op("batch",{requiredFields:["size"]}),[diagnosticMembers[0]]);
    const child=session.execute(op("child",{dependsOn:["batch"]}));
    expect((await batch)[0].status).toBe("failed");expect((await child).reason).toBe("DEPENDENCY_NOT_SUCCESSFUL");expect(spy).toHaveBeenCalledTimes(1);
  });
  it("an incomplete diagnostic result cannot satisfy the parent dependency or poison members",async()=>{
    const {session,spy}=fixture(async()=>ok({operations:[],failed:0}));
    const batch=session.diagnostics(op("batch"),diagnosticMembers);const child=session.execute(op("child",{dependsOn:["batch"]}));
    expect((await batch).every(x=>x.reason==="BATCH_RESULT_UNAVAILABLE")).toBe(true);
    expect((await child).reason).toBe("DEPENDENCY_NOT_SUCCESSFUL");
    spy.mockResolvedValue(ok());expect((await session.execute(op("member",{intent:"inspect",target:"a"}))).status).toBe("succeeded");
  });
  it("member transport retryability and the two-retry ceiling survive batch splitting",async()=>{
    const transport={ok:false,error:{code:"TRANSPORT",retryable:true}};
    const {session,spy}=fixture(async()=>ok({operations:[transport],failed:1}));
    await session.diagnostics(op("first"),[diagnosticMembers[0]]);
    for(let i=0;i<2;i++)expect((await session.diagnostics(op("retry"+i,{change:{kind:"transport",evidenceId:String(i)}}),[diagnosticMembers[0]]))[0]).toMatchObject({status:"failed",errorClass:"TRANSPORT"});
    expect((await session.diagnostics(op("exhausted",{change:{kind:"transport",evidenceId:"third"}}),[diagnosticMembers[0]]))[0].reason).toBe("EQUIVALENT_RETRY");
    expect(spy).toHaveBeenCalledTimes(3);
  });
  it("a child waiting on a guarded partial batch never observes an intermediate member success",async()=>{
    const hold=deferred();const {session,spy}=fixture(async()=>partial());await session.diagnostics(op("first"),diagnosticMembers);
    spy.mockImplementation(async()=>hold.promise);
    // B succeeds first; A retains its denial and is suppressed second.
    const batch=session.diagnostics(op("guarded"),[diagnosticMembers[1],diagnosticMembers[0]]);
    const child=session.execute(op("child",{dependsOn:["guarded"]}));await Promise.resolve();hold.resolve(ok({operations:[ok({size:1})],failed:0}));
    expect((await batch).map(x=>x.status)).toEqual(["succeeded","suppressed"]);
    expect((await child).reason).toBe("DEPENDENCY_NOT_SUCCESSFUL");expect(spy).toHaveBeenCalledTimes(2);
  });
  it("history-aware diagnostics recover with only one observer slot",async()=>{
    const {session,spy}=fixture(async()=>partial(),{in_flight:1});await session.diagnostics(op("first"),diagnosticMembers);
    spy.mockResolvedValue(ok({operations:[ok({size:1})],failed:0}));
    expect((await session.diagnostics(op("approved",{change:{kind:"capability",evidenceId:"restored"}}),diagnosticMembers)).map(x=>x.status)).toEqual(["succeeded","succeeded"]);
    expect(spy).toHaveBeenCalledTimes(3);expect(session.snapshot().in_flight).toBe(0);
  });
  it("a guarded diagnostic batch retains its parent dependency and immutable operation ID",async()=>{
    const {session,spy}=fixture(async()=>partial());await session.diagnostics(op("first"),diagnosticMembers);
    spy.mockResolvedValue(ok({operations:[ok({size:1})],failed:0}));
    const approved=op("approved",{change:{kind:"capability",evidenceId:"restored"}});
    expect((await session.diagnostics(approved,[diagnosticMembers[0]]))[0].status).toBe("succeeded");
    spy.mockResolvedValue(ok());
    expect((await session.execute(op("child",{dependsOn:["approved"]}))).status).toBe("succeeded");
    const before=spy.mock.calls.length;
    expect((await session.diagnostics({...approved,authorization:"different"},[diagnosticMembers[0]]))[0].reason).toBe("OPERATION_ID_REUSED");
    expect((await session.execute(op("approved"))).reason).toBe("OPERATION_ID_REUSED");
    await session.diagnostics(approved,[diagnosticMembers[0]]);expect(spy).toHaveBeenCalledTimes(before);
  });
  it("read aggregate transport failure does not invent individual failure history",async()=>{
    const {session,spy}=fixture(async()=>{throw Object.assign(new Error("lost response"),{code:"ETIMEDOUT"});});
    expect((await session.readFiles(op("batch",{intent:"read"}),files,true)).every(x=>x.errorClass==="TRANSPORT")).toBe(true);
    spy.mockResolvedValue(ok({content:"x"}));
    expect((await session.execute(op("individual",{intent:"read",target:"a",call:{name:"host_read_file",arguments:{path:"a"}},requiredFields:["content"]}))).status).toBe("succeeded");
  });
  it("diagnostic admission suppression leaves no member history",async()=>{
    let fail=true;const {session,spy}=fixture(async()=>partial(),{event_queue:1},()=>{if(fail)throw new Error("sink unavailable");});
    session.progress.lane("setup","setup","setup");session.progress.event("setup",{type:"attempt"});
    expect((await session.diagnostics(op("batch"),diagnosticMembers)).every(x=>x.reason==="WORKFLOW_CAPACITY:event_queue")).toBe(true);
    expect(spy).not.toHaveBeenCalled();expect(session.snapshot().history_intents).toBe(0);
    fail=false;session.progress.drainUndelivered();
    expect((await session.diagnostics(op("retry"),diagnosticMembers)).map(x=>x.status)).toEqual(["failed","succeeded"]);
  });
  it("implicit diagnostic identity is stable under argument-property reordering",async()=>{
    const {session,spy}=fixture(async()=>ok({operations:[denied()],failed:1}));
    await session.diagnostics(op("a",{intent:"probe"}),[{tool:"http_probe",args:{url:"https://example.invalid",method:"GET"}}]);
    expect((await session.diagnostics(op("b",{intent:"probe"}),[{tool:"http_probe",args:{method:"GET",url:"https://example.invalid"}}]))[0].reason).toBe("EQUIVALENT_RETRY");
    expect(spy).toHaveBeenCalledTimes(1);
  });
  it("an unverified authorization label cannot reset a diagnostic denial",async()=>{
    const {session,spy,verifyChange}=fixture(async()=>partial());await session.diagnostics(op("batch"),diagnosticMembers);
    verifyChange.mockResolvedValue(false);
    expect((await session.diagnostics(op("retry",{authorization:"b",change:{kind:"approval",evidenceId:"unverified"}}),[diagnosticMembers[0]]))[0].reason).toBe("EQUIVALENT_RETRY");
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
