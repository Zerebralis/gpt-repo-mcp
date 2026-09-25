import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentToolSession, checkResult, classifyError, type Operation, type ToolCall } from "../src/agent-orchestration.js";
import type { ProgressEvent } from "../src/orchestration/progress.js";

const success=(result:Record<string,unknown>={done:true})=>({content:[{type:"text",text:JSON.stringify({ok:true,result})}]});
const failure=(code="BACKEND_POLICY",retryable=false)=>({isError:true,content:[{type:"text",text:JSON.stringify({ok:false,error:{code,retryable}})}]});
const op=(id:string,extra:Partial<Operation>={}):Operation=>({id,subtask:"lane",intent:id,target:"target",authorization:"a1",call:{name:"host_shell",arguments:{}},mutating:false,...extra});
const sessions:AgentToolSession[]=[];
function fixture(dispatch:(call:ToolCall)=>Promise<unknown>=async()=>success(),verifyChange?:ConstructorParameters<typeof AgentToolSession>[0]["verifyChange"]) {
  let now=0;const events:ProgressEvent[]=[];const spy=vi.fn(dispatch);
  const session=new AgentToolSession({dispatch:spy,availableTools:new Set(["host_shell","host_process_start","host_process_output","host_read_file","host_read_many","host_diagnostics_batch","host_stat","host_write_file"]),onEvent:e=>events.push(e),now:()=>now,verifyChange});
  sessions.push(session);return {session,spy,events,advance:(ms:number)=>{now+=ms;session.progress.tick();}};
}
afterEach(()=>{sessions.splice(0).forEach(s=>s.close());vi.useRealTimers();});

describe("caller orchestration contract",()=>{
  it.each([failure(),{isError:true},success({exit_code:2}),{ok:false},{},success({timed_out:true})])("T1 does not dispatch child of failed parent",async result=>{
    const {session,spy}=fixture(async()=>result);
    await session.execute(op("write",{mutating:true,call:{name:"host_write_file",arguments:{}}}));
    expect((await session.execute(op("execute",{dependsOn:["write"]}))).status).toBe("suppressed");
    expect(spy).toHaveBeenCalledTimes(1);
  });
  it("T1 permits child only after parent success and validates required fields",async()=>{
    const {session,spy}=fixture();
    await session.execute(op("write",{mutating:true,requiredFields:["done"]}));
    expect((await session.execute(op("execute",{dependsOn:["write"]}))).status).toBe("succeeded");
    expect(spy).toHaveBeenCalledTimes(2);
    expect((await session.execute(op("missing",{requiredFields:["receipt"]}))).status).toBe("failed");
  });
  it("T2 independent B continues when parallel A fails",async()=>{
    const {session}=fixture(async c=>c.name==="host_stat"?failure():success({content:"B"}));
    const [a,b]=await Promise.all([session.execute(op("a",{call:{name:"host_stat",arguments:{}}})),session.execute(op("b"))]);
    expect(a.status).toBe("failed");expect(b.status).toBe("succeeded");
  });
  it("T3 blocks equivalent effect through different executor and different operation id",async()=>{
    const {session,spy,events}=fixture(async()=>failure());
    await session.execute(op("a",{intent:"stop"}));
    const retry=await session.execute(op("b",{intent:"stop",call:{name:"host_process_start",arguments:{different:"syntax"}}}));
    expect(retry.reason).toBe("EQUIVALENT_RETRY");expect(spy).toHaveBeenCalledTimes(1);
    expect(events.filter(e=>e.type==="blocker")).toHaveLength(1);
  });
  it("T4 verifies genuinely changed approval; second denial stops even with another change",async()=>{
    const verified=vi.fn(async(o:Operation,p:Readonly<{authorization:string}>)=>o.authorization!==p.authorization&&o.change?.evidenceId==="approved");
    const {session,spy}=fixture(async()=>failure(),verified);
    await session.execute(op("a",{intent:"write"}));
    expect((await session.execute(op("b",{intent:"write",authorization:"a2",change:{kind:"approval",evidenceId:"approved"}}))).status).toBe("failed");
    expect((await session.execute(op("c",{intent:"write",authorization:"a3",change:{kind:"approval",evidenceId:"approved-again"}}))).status).toBe("suppressed");
    expect(spy).toHaveBeenCalledTimes(2);
  });
  it("changed labels alone do not authorize reconsideration",async()=>{
    const {session,spy}=fixture(async()=>failure());await session.execute(op("a",{intent:"same"}));
    await session.execute(op("b",{intent:"same",authorization:"new",change:{kind:"approval",evidenceId:"claim"}}));
    expect(spy).toHaveBeenCalledTimes(1);
  });
  it("structured first preserves arguments and never routes around a prior denial",async()=>{
    const {session,spy}=fixture(async()=>failure());
    await session.execute(op("a",{intent:"inspect",structuredAlternative:{name:"host_stat",arguments:{path:"known"}}}));
    expect(spy.mock.calls[0][0]).toEqual({name:"host_stat",arguments:{path:"known"}});
    await session.execute(op("b",{intent:"inspect"}));expect(spy).toHaveBeenCalledTimes(1);
  });
  it("T5 three known independent reads use one partial-result batch",async()=>{
    const {session,spy}=fixture(async()=>success({files:[{content:"a"},{content:"b"},{content:"c"}],failed:0}));
    const results=await session.readFiles(op("read"),["a","b","c"].map(path=>({path,length:10})),true);
    expect(results.map(r=>r.status)).toEqual(["succeeded","succeeded","succeeded"]);
    expect(spy).toHaveBeenCalledTimes(1);expect(spy.mock.calls[0][0].name).toBe("host_read_many");
  });
  it("batch keeps independent successes but aggregate failure blocks dependent work",async()=>{
    const {session,spy}=fixture(async()=>success({files:[{ok:false,error:{code:"AUTH"}},{content:"b"}],failed:1}));
    const result=await session.readFiles(op("read"),[{path:"a",length:10},{path:"b",length:10}],true);
    expect(result.map(r=>r.status)).toEqual(["failed","succeeded"]);
    expect((await session.execute(op("child",{dependsOn:["read"]}))).status).toBe("suppressed");
    expect(spy).toHaveBeenCalledTimes(1);
  });
  it("old read-many capability falls back to independent reads, never to shell",async()=>{
    const {session,spy}=fixture(async c=>c.arguments.path==="a"?failure():success({content:"b"}));
    expect((await session.readFiles(op("read"),[{path:"a",length:10},{path:"b",length:10}],false)).map(r=>r.status)).toEqual(["failed","succeeded"]);
    expect(spy.mock.calls.every(c=>c[0].name==="host_read_file")).toBe(true);
  });
  it("batch members retain denial history across an executor change",async()=>{
    const {session,spy}=fixture(async()=>success({files:[{ok:false,error:{code:"BACKEND_POLICY"}},{content:"b"}],failed:1}));
    await session.readFiles(op("read",{intent:"read"}),[{path:"a",length:10},{path:"b",length:10}],true);
    const retry=await session.execute(op("retry",{intent:"read",target:"a"}));
    expect(retry.reason).toBe("EQUIVALENT_RETRY");expect(spy).toHaveBeenCalledTimes(1);
  });
  it("a batch cannot repackage a previously denied member",async()=>{
    const {session,spy}=fixture(async c=>c.name==="host_shell"?failure():success({content:"b"}));
    await session.execute(op("first",{intent:"read",target:"a"}));
    const results=await session.readFiles(op("read",{intent:"read"}),[{path:"a",length:10},{path:"b",length:10}],true);
    expect(results.map(x=>x.status)).toEqual(["suppressed","succeeded"]);
    expect(spy.mock.calls.map(c=>c[0].name)).toEqual(["host_shell","host_read_file"]);
  });
  it("operation ids cannot be reused for a different effect",async()=>{
    const {session,spy}=fixture();await session.execute(op("same-id"));
    expect((await session.execute(op("same-id",{target:"different"}))).reason).toBe("OPERATION_ID_REUSED");expect(spy).toHaveBeenCalledTimes(1);
  });
  it("long synchronous shell budget requires an explicit authorized job plan",async()=>{
    const {session,spy}=fixture();
    expect((await session.execute(op("long",{call:{name:"host_shell",arguments:{timeout_ms:120_000}}}))).reason).toBe("JOB_START_REQUIRED");
    expect(spy).not.toHaveBeenCalled();
  });
  it("T6 derived paths cannot be pre-batched; read only after successful parent",async()=>{
    const {session,spy}=fixture(async()=>success({content:"derived"}));
    expect((await session.readFiles(op("read",{dependsOn:["parent"]}),[{path:"not-yet-known",length:10}],true))[0].status).toBe("suppressed");
    expect(spy).not.toHaveBeenCalled();
    await session.execute(op("parent"));
    await session.execute(op("child",{dependsOn:["parent"],call:{name:"host_read_file",arguments:{path:"derived"}}}));
    expect(spy).toHaveBeenCalledTimes(2);
  });
  it("diagnostics preserves errors and does not confuse managed jobs with OS processes",async()=>{
    const {session,spy}=fixture(async()=>success({operations:[{ok:false,error:"no access"},{ok:true,result:{node:"test"}}],failed:1}));
    const result=await session.diagnostics(op("diag"),[{tool:"stat",args:{}},{tool:"system_info",args:{}}]);
    expect(result.map(r=>r.status)).toEqual(["failed","succeeded"]);
    expect((await session.diagnostics(op("bad"),[{tool:"process_list",args:{}}]))[0].status).toBe("suppressed");
    expect(spy).toHaveBeenCalledTimes(1);
  });
  it("T7 reports hard block immediately and escalates at 3/5 active minutes without spam",async()=>{
    const {session,events,advance}=fixture(async()=>failure());await session.execute(op("a"));
    expect(events.some(e=>e.type==="blocker")).toBe(true);
    for(let i=0;i<10;i++)advance(30_000);
    expect(events.filter(e=>e.type==="stall_check")).toHaveLength(1);
    expect(events.filter(e=>e.type==="status_update")).toHaveLength(1);
    advance(300_000);expect(events.filter(e=>e.type==="status_update")).toHaveLength(1);
  });
  it("approval waits pause active clock; unchanged evidence and another lane do not reset it",async()=>{
    const {session,events,advance}=fixture();await session.execute(op("a"));
    session.progress.progress("lane","e1");session.progress.pause("lane",true);advance(600_000);
    expect(events.some(e=>e.type==="status_update")).toBe(false);
    session.progress.pause("lane",false);advance(150_000);session.progress.progress("lane","e1");
    await session.execute(op("other",{subtask:"other"}));session.progress.progress("other","new");advance(150_000);
    expect(events.filter(e=>e.type==="status_update")).toHaveLength(1);
  });
  it("T8 long work starts once, polls later with backoff and only completion satisfies dependency",async()=>{
    let polls=0;
    const {session,spy,advance}=fixture(async c=>c.name==="host_process_start"?success({job_id:"job",status:"running"}):c.name==="host_process_output"?success({job_id:"job",status:++polls===1?"running":"exited",...(polls===2?{exit_code:0}:{})}):success());
    const job=op("job",{intent:"build",mutating:true,longRunning:true,jobStart:{name:"host_process_start",arguments:{executable:"node",approval:"unchanged"}}});
    expect((await session.execute(job)).status).toBe("running");
    expect((await session.execute(op("early-child",{dependsOn:["job"]}))).status).toBe("suppressed");
    await session.poll("job");expect(spy).toHaveBeenCalledTimes(1);
    advance(5_000);await session.poll("job");advance(5_000);await session.poll("job");expect(polls).toBe(1);
    advance(5_000);expect((await session.poll("job")).status).toBe("succeeded");
    expect((await session.execute(op("child",{dependsOn:["job"]}))).status).toBe("succeeded");
    expect(spy.mock.calls.filter(c=>c[0].name==="host_process_start")).toHaveLength(1);
  });
  it("T9 ambiguous mutating start never duplicates, even after a claimed approval change",async()=>{
    const {session,spy}=fixture(async()=>{throw Object.assign(new Error("timeout"),{code:"ETIMEDOUT"});},async()=>true);
    const start={intent:"build",mutating:true,longRunning:true,jobStart:{name:"host_process_start",arguments:{}}};
    expect((await session.execute(op("job",start))).status).toBe("ambiguous");
    expect((await session.execute(op("retry",{...start,authorization:"new",change:{kind:"approval",evidenceId:"new"}}))).reason).toBe("RECONCILE_REQUIRED");
    expect(spy).toHaveBeenCalledTimes(1);
  });
  it("running and uncertain jobs prevent replacement start; poll reconciliation may still complete",async()=>{
    let polls=0;
    const {session,spy,advance}=fixture(async c=>c.name==="host_process_start"?success({job_id:"j",status:"running"}):++polls===1?failure("TRANSPORT",true):success({job_id:"j",status:"exited",exit_code:0}));
    const start={intent:"build",mutating:true,longRunning:true,jobStart:{name:"host_process_start",arguments:{}}};
    await session.execute(op("job",start));await session.execute(op("replacement",start));
    advance(5_000);expect((await session.poll("job")).status).toBe("ambiguous");
    await session.execute(op("replacement2",start));advance(10_000);expect((await session.poll("job")).status).toBe("succeeded");
    expect(spy.mock.calls.filter(c=>c[0].name==="host_process_start")).toHaveLength(1);
  });
  it("failed terminal exit cannot satisfy child and is not polled forever",async()=>{
    const {session,advance}=fixture(async c=>success(c.name==="host_process_start"?{job_id:"j",status:"running"}:{job_id:"j",status:"exited",exit_code:9}));
    await session.execute(op("job",{mutating:true,longRunning:true,jobStart:{name:"host_process_start",arguments:{}}}));advance(5_000);
    expect((await session.poll("job")).status).toBe("failed");expect((await session.poll("job")).reason).toBe("UNKNOWN_JOB");
    expect((await session.execute(op("child",{dependsOn:["job"]}))).status).toBe("suppressed");
  });
  it("a bounded call timeout aborts observation and retains ambiguous mutation state",async()=>{
    vi.useFakeTimers();let aborted=false;
    const s=new AgentToolSession({availableTools:new Set(["host_shell"]),dispatch:async(_c,{signal})=>{signal.addEventListener("abort",()=>{aborted=true;});return new Promise(()=>{});},onEvent:()=>{},requestTimeoutMs:100});sessions.push(s);
    const pending=s.execute(op("write",{mutating:true}));await vi.advanceTimersByTimeAsync(101);
    expect((await pending).status).toBe("ambiguous");expect(aborted).toBe(true);
  });
  it("concurrent equivalent operations do not race through the dispatch guard",async()=>{
    let release!:(x:unknown)=>void;const {session,spy}=fixture(()=>new Promise(r=>{release=r;}));
    const first=session.execute(op("a",{intent:"same"}));
    const second=session.execute(op("b",{intent:"same"}));await Promise.resolve();await Promise.resolve();
    expect((await second).status).toBe("suppressed");release(success());await first;expect(spy).toHaveBeenCalledTimes(1);
  });
  it("unknown forward dependencies are suppressed rather than creating cycles",async()=>{
    const {session,spy}=fixture();const a=session.execute(op("a",{dependsOn:["b"]}));const b=session.execute(op("b",{dependsOn:["a"]}));
    expect((await Promise.all([a,b])).every(x=>x.status==="suppressed")).toBe(true);expect(spy).not.toHaveBeenCalled();
  });
  it("bounded read-only transport retries require evidence; policy does not inherit retryable",async()=>{
    const {session,spy}=fixture(async()=>failure("TRANSPORT",true),async()=>true);
    for(let i=0;i<4;i++)await session.execute(op(String(i),{intent:"read",change:{kind:"transport",evidenceId:String(i)}}));
    expect(spy).toHaveBeenCalledTimes(3);
  });
  it("telemetry contains no arguments, target paths, output or authorization content",async()=>{
    const {session,events}=fixture(async()=>failure());
    await session.execute(op("id",{target:"private/path",authorization:"private-approval",call:{name:"host_shell",arguments:{command:"private-command"}}}));
    expect(JSON.stringify(events)).not.toMatch(/private/);
  });
});

describe("tool result normalization",()=>{
  it("keeps successful mutation despite a separate audit-warning block",()=>{
    const result=success({written:true});result.content.push({type:"text",text:JSON.stringify({audit:{ok:false}})});
    expect(checkResult(result).ok).toBe(true);
  });
  it("prefers native error code to misleading text and does not scan successful file contents",()=>{
    expect(classifyError({error:{code:"INVALID_ARGUMENT",message:"Command blocked by host-breakglass safe policy"}})).toBe("ARGUMENT");
    expect(checkResult(success({content:"Command blocked by host-breakglass safe policy"})).ok).toBe(true);
    expect(checkResult({isError:true,content:[{type:"text",text:"This action was rejected due to unacceptable risk"}]}).errorClass).toBe("UPSTREAM_AUTO_REVIEW");
  });
  it.each(["UPSTREAM_AUTO_REVIEW","BACKEND_POLICY","LOCAL_EXEC_POLICY","TRANSPORT","ARGUMENT","AUTH","APPROVAL_PENDING","EXPECTED_REVIEW_BLOCKED","UNKNOWN"])("preserves native class %s",code=>expect(checkResult(failure(code)).errorClass).toBe(code));
});
