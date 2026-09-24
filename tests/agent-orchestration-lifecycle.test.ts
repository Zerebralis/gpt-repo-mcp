import {afterEach,describe,expect,it,vi} from "vitest";
import {AgentToolSession,type Operation,type ToolCall,type SessionLimits} from "../src/agent-orchestration.js";
import type {ProgressEvent} from "../src/orchestration/progress.js";

const ok=(result:Record<string,unknown>={done:true})=>({ok:true,result});
const denied=()=>({ok:false,error:{code:"BACKEND_POLICY",retryable:false}});
const op=(id:string,extra:Partial<Operation>={}):Operation=>({id,subtask:"workflow",intent:id,target:"fixture",authorization:"a",mutating:false,call:{name:"host_stat",arguments:{}},...extra});
const sessions:AgentToolSession[]=[];
function fixture(dispatch:(call:ToolCall)=>Promise<unknown>=async()=>ok(),limits:Partial<SessionLimits>={}) {
  const events:ProgressEvent[]=[];let now=0;const spy=vi.fn(dispatch);
  const session=new AgentToolSession({dispatch:spy,availableTools:new Set(["host_stat","host_read_file","host_read_many","host_diagnostics_batch","host_process_start","host_process_output"]),onEvent:e=>events.push(e),limits,now:()=>now});
  sessions.push(session);return {session,events,spy,advance:(ms:number)=>{now+=ms;session.progress.tick();}};
}
const job=(id:string)=>op(id,{mutating:true,longRunning:true,jobStart:{name:"host_process_start",arguments:{}}});
afterEach(()=>{sessions.splice(0).forEach(s=>s.close());});

describe("capacity and terminal session lifecycle",()=>{
  it("C1 10,000 sequential distinct operations release pending and clean intents",async()=>{
    let concurrent=0,max=0;
    const {session}=fixture(async()=>{concurrent++;max=Math.max(max,concurrent);await Promise.resolve();concurrent--;return ok();});
    for(let i=0;i<10_000;i++) {
      expect((await session.execute(op(String(i)))).status).toBe("succeeded");
      expect(session.snapshot().in_flight).toBe(0);
    }
    expect(max).toBe(1);
    expect(session.snapshot()).toMatchObject({terminal_records:10_000,identities:10_000,history_intents:0,in_flight:0,retained_full_results:0});
  });
  it("C2 early denial survives 1,000 independent completions",async()=>{
    const {session,spy}=fixture(async c=>c.arguments.deny?denied():ok());
    await session.execute(op("denied",{intent:"protected",call:{name:"host_stat",arguments:{deny:true}}}));
    for(let i=0;i<1000;i++)await session.execute(op(String(i)));
    expect((await session.execute(op("retry",{intent:"protected"}))).reason).toBe("EQUIVALENT_RETRY");
    expect(spy).toHaveBeenCalledTimes(1001);
  });
  it("C3 compact success and failure records still decide late dependencies",async()=>{
    const {session}=fixture(async c=>c.arguments.deny?denied():ok({payload:"large-result"}));
    const good=op("good"),bad=op("bad",{call:{name:"host_stat",arguments:{deny:true}}});
    await session.execute(good);await session.execute(bad);
    for(let i=0;i<1000;i++)await session.execute(op(String(i)));
    expect(await session.execute(good)).toMatchObject({status:"succeeded",result_retained:false});
    expect((await session.execute(good)).value).toBeUndefined();
    expect((await session.execute(op("child-good",{dependsOn:["good"]}))).status).toBe("succeeded");
    expect((await session.execute(op("child-bad",{dependsOn:["bad"]}))).reason).toBe("DEPENDENCY_NOT_SUCCESSFUL");
  });
  it("C4 compact old operation identity still rejects a changed effect",async()=>{
    const {session,spy}=fixture();await session.execute(op("original"));
    for(let i=0;i<1000;i++)await session.execute(op(String(i)));
    expect((await session.execute(op("original",{target:"other"}))).reason).toBe("OPERATION_ID_REUSED");
    expect(spy).toHaveBeenCalledTimes(1001);
  });
  it("C5 closed session refuses all four dispatch entrypoints",async()=>{
    const {session,spy}=fixture();session.close();session.close();
    expect((await session.execute(op("a"))).reason).toBe("SESSION_CLOSED");
    expect((await session.readFiles(op("b"),[{path:"fixture",length:1}],true))[0].reason).toBe("SESSION_CLOSED");
    expect((await session.diagnostics(op("c"),[{tool:"stat",args:{}}]))[0].reason).toBe("SESSION_CLOSED");
    expect((await session.poll("job")).reason).toBe("SESSION_CLOSED");expect(spy).not.toHaveBeenCalled();
    expect(session.snapshot().state).toBe("closed");
  });
  it("C6 close retains active mutating job identity for external reconciliation",async()=>{
    const {session,spy}=fixture(async()=>ok({job_id:"known-job",status:"running"}));
    await session.execute(job("j"));session.close();
    expect(session.snapshot()).toMatchObject({state:"closed",rollover_supported:false,jobs:[{operation_id:"j",job_id:"known-job",mutating:true}]});
    expect((await session.execute(job("replacement"))).reason).toBe("SESSION_CLOSED");
    expect((await session.poll("j")).reason).toBe("SESSION_CLOSED");expect(spy).toHaveBeenCalledTimes(1);
  });
  it("C7 more than 256 exact evidence fingerprints work and old evidence cannot reset time",async()=>{
    const {session,events,advance}=fixture();await session.execute(op("a"));
    for(let i=0;i<1000;i++)expect(session.progress.progress("workflow",String(i))).toBe(true);
    advance(150_000);expect(session.progress.progress("workflow","0")).toBe(false);advance(150_000);
    expect(events.filter(e=>e.type==="status_update")).toHaveLength(1);
  });
  it("C8 in-flight capacity emits one typed block and recovers after completion",async()=>{
    let release!:(x:unknown)=>void;
    const {session,events,spy}=fixture(()=>new Promise(r=>{release=r;}),{in_flight:1});
    const first=session.execute(op("first"));await Promise.resolve();
    for(let i=0;i<3;i++)expect((await session.execute(op("blocked"+i))).reason).toBe("WORKFLOW_CAPACITY:in_flight");
    expect(events.filter(e=>e.type==="capacity_block"&&e.scope==="in_flight")).toHaveLength(1);
    release(ok());await first;spy.mockImplementation(async()=>ok());
    expect((await session.execute(op("after"))).status).toBe("succeeded");
  });
  it("C9 large terminal payloads are returned once but not retained by the session",async()=>{
    const payload="payload:"+"x".repeat(256*1024);
    const {session}=fixture(async()=>ok({payload}));
    for(let i=0;i<400;i++)expect((await session.execute(op(String(i)))).value?.payload).toBe(payload);
    const internal=session as unknown as {pending:Map<string,unknown>;outcomes:Map<string,unknown>;identities:Map<string,unknown>};
    expect(internal.pending.size).toBe(0);
    expect(JSON.stringify([...internal.outcomes.values()])).not.toContain("payload");
    expect(JSON.stringify([...internal.identities.values()])).not.toContain("payload");
    expect((await session.execute(op("0"))).value).toBeUndefined();
  });
  it("close during an in-flight mutation lets observation finish without claiming cancellation",async()=>{
    let release!:(x:unknown)=>void;const {session,spy}=fixture(()=>new Promise(r=>{release=r;}));
    const pending=session.execute(op("write",{mutating:true}));await Promise.resolve();session.close();
    expect(session.snapshot().state).toBe("closing");
    expect((await session.execute(op("new"))).reason).toBe("SESSION_CLOSED");
    release(ok());expect((await pending).status).toBe("succeeded");
    expect(session.snapshot()).toMatchObject({state:"closed",in_flight:0});expect(spy).toHaveBeenCalledTimes(1);
  });
  it("close before dispatch suppresses queued operations",async()=>{
    const {session,spy}=fixture();const p=session.execute(op("queued"));session.close();
    expect((await p).reason).toBe("SESSION_CLOSED");expect(spy).not.toHaveBeenCalled();
  });
  it("close while waiting for parent cannot dispatch the waiting child",async()=>{
    let release!:(x:unknown)=>void;const {session,spy}=fixture(()=>new Promise(r=>{release=r;}));
    const p=session.execute(op("parent"));const child=session.execute(op("child",{dependsOn:["parent"]}));
    await Promise.resolve();session.close();release(ok());await p;
    expect((await child).reason).toBe("SESSION_CLOSED");expect(spy).toHaveBeenCalledTimes(1);
  });
  it("late ambiguous mutation outcome survives close",async()=>{
    let reject!:(e:Error)=>void;const {session}=fixture(()=>new Promise((_,r)=>{reject=r;}));
    const p=session.execute(op("write",{mutating:true}));await Promise.resolve();session.close();
    reject(Object.assign(new Error("fixture"),{code:"ETIMEDOUT"}));expect((await p).status).toBe("ambiguous");
    expect(session.snapshot().ambiguous_intents).toHaveLength(1);expect(session.snapshot().state).toBe("closed");
  });
  it("terminal metadata capacity warns then blocks without erasing old identity",async()=>{
    const {session,events}=fixture(undefined,{terminal:3});
    for(let i=0;i<3;i++)await session.execute(op(String(i)));
    for(let i=0;i<2;i++)expect((await session.execute(op("new"+i))).reason).toBe("WORKFLOW_CAPACITY:terminal");
    expect(events.filter(e=>e.scope==="terminal"&&e.type==="capacity_warning")).toHaveLength(1);
    expect(events.filter(e=>e.scope==="terminal"&&e.type==="capacity_block")).toHaveLength(1);
    expect((await session.execute(op("0",{target:"other"}))).reason).toBe("OPERATION_ID_REUSED");
  });
  it("safety history capacity preserves denials rather than evicting them",async()=>{
    const {session,events,spy}=fixture(async()=>denied(),{history:2});
    await session.execute(op("a"));await session.execute(op("b"));
    expect((await session.execute(op("c"))).reason).toBe("WORKFLOW_CAPACITY:history");
    expect((await session.execute(op("retry",{intent:"a"}))).reason).toBe("EQUIVALENT_RETRY");
    expect(events.some(e=>e.scope==="history"&&e.type==="capacity_block")).toBe(true);expect(spy).toHaveBeenCalledTimes(2);
  });
  it("progress lane and evidence capacities are typed, deduplicated and nonthrowing",async()=>{
    const {session,events}=fixture(undefined,{lanes:1,evidence:2});await session.execute(op("a"));
    expect((await session.execute(op("other",{subtask:"other"}))).reason).toBe("WORKFLOW_CAPACITY:lanes");
    expect(session.progress.progress("workflow","1")).toBe(true);expect(session.progress.progress("workflow","2")).toBe(true);
    expect(session.progress.progress("workflow","3")).toBe(false);expect(session.progress.progress("workflow","4")).toBe(false);
    expect(events.filter(e=>e.scope==="evidence"&&e.type==="capacity_block")).toHaveLength(1);
    expect(session.snapshot().progress.evidence).toBe(2);
  });
  it("active job capacity includes concurrent start reservations",async()=>{
    let release!:(x:unknown)=>void;const {session,events,spy}=fixture(()=>new Promise(r=>{release=r;}),{jobs:1});
    const first=session.execute(job("one"));await Promise.resolve();
    expect((await session.execute(job("two"))).reason).toBe("WORKFLOW_CAPACITY:jobs");
    release(ok({job_id:"j",status:"running"}));await first;
    expect(events.some(e=>e.scope==="jobs"&&e.type==="capacity_block")).toBe(true);expect(spy).toHaveBeenCalledTimes(1);
  });
  it("active intent capacity is released by successful completion",async()=>{
    let release!:(x:unknown)=>void;const {session,spy}=fixture(()=>new Promise(r=>{release=r;}),{active_intents:1});
    const first=session.execute(op("one"));await Promise.resolve();
    expect((await session.execute(op("two"))).reason).toBe("WORKFLOW_CAPACITY:active_intents");release(ok());await first;
    spy.mockImplementation(async()=>ok());expect((await session.execute(op("three"))).status).toBe("succeeded");
  });
  it("delivery queue backpressure and overflow remain observable and recoverable",async()=>{
    let deliver=false;const s=new AgentToolSession({availableTools:new Set(["host_stat"]),dispatch:async()=>ok(),onEvent:()=>{if(!deliver)throw new Error("fixture");},limits:{event_queue:1}});sessions.push(s);
    await s.execute(op("one"));
    expect((await s.execute(op("two"))).reason).toBe("WORKFLOW_CAPACITY:event_queue");
    const events=s.progress.drainUndelivered();expect(events.some(e=>e.scope==="event_queue"&&e.dropped_events!>0)).toBe(true);
    deliver=true;expect((await s.execute(op("three"))).status).toBe("succeeded");
  });
  it("a job ID arriving after close is retained, with no replacement dispatch",async()=>{
    let release!:(x:unknown)=>void;const {session,spy}=fixture(()=>new Promise(r=>{release=r;}));
    const start=session.execute(job("late"));await Promise.resolve();session.close();
    release(ok({job_id:"late-id",status:"running"}));await start;
    expect(session.snapshot()).toMatchObject({state:"closed",jobs:[{operation_id:"late",job_id:"late-id"}]});
    expect((await session.execute(job("replacement"))).reason).toBe("SESSION_CLOSED");expect(spy).toHaveBeenCalledTimes(1);
  });
  it("an in-flight poll can settle after close and releases terminal job state",async()=>{
    let release!:(x:unknown)=>void;let calls=0;
    const {session,advance}=fixture(()=>++calls===1?Promise.resolve(ok({job_id:"j",status:"running"})):new Promise(r=>{release=r;}));
    await session.execute(job("j"));advance(5000);const poll=session.poll("j");session.close();
    expect(session.snapshot().state).toBe("closing");release(ok({job_id:"j",status:"exited",exit_code:0}));
    expect((await poll).status).toBe("succeeded");expect(session.snapshot()).toMatchObject({state:"closed",jobs:[],history_intents:0});
  });
  it("successful batch members and aggregates do not consume permanent history capacity",async()=>{
    const {session}=fixture(async()=>ok({files:[{content:"a"},{content:"b"}],failed:0}),{history:4,active_intents:4});
    for(let i=0;i<1000;i++) {
      expect((await session.readFiles(op(String(i)),[{path:"a",length:1},{path:"b",length:1}],true)).every(x=>x.status==="succeeded")).toBe(true);
      expect(session.snapshot()).toMatchObject({in_flight:0,history_intents:0});
    }
  });
  it("close during asynchronous prerequisite verification prevents dispatch",async()=>{
    let release!:(x:boolean)=>void;const dispatch=vi.fn(async()=>denied());
    const session=new AgentToolSession({dispatch,availableTools:new Set(["host_stat"]),onEvent:()=>{},verifyChange:()=>new Promise(r=>{release=r;})});sessions.push(session);
    await session.execute(op("first",{intent:"same"}));
    const retry=session.execute(op("retry",{intent:"same",authorization:"changed",change:{kind:"approval",evidenceId:"verified"}}));
    await Promise.resolve();session.close();release(true);
    expect((await retry).reason).toBe("SESSION_CLOSED");expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
