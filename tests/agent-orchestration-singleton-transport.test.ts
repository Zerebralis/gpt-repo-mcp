import {createHash} from "node:crypto";
import {afterEach,describe,expect,it,vi} from "vitest";
import {AgentToolSession,type Operation,type DiagnosticMember} from "../src/agent-orchestration.js";

const ok=(result:Record<string,unknown>)=>({ok:true,result});
const op=(id:string,extra:Partial<Operation>={}):Operation=>({id,subtask:"workflow",intent:"inspect",target:"a",authorization:"a",mutating:false,call:{name:"host_stat",arguments:{}},...extra});
const member=(target="a"):DiagnosticMember=>({tool:"stat",args:{path:target},identity:{intent:"inspect",target}});
const timeout=()=>Object.assign(new Error("aggregate response lost"),{code:"ETIMEDOUT"});
const transportChange=(id:string)=>({kind:"transport" as const,evidenceId:id});
const sessions:AgentToolSession[]=[];
function fixture() {
  const dispatch=vi.fn(async():Promise<unknown>=>ok({size:1}));
  const verifyChange=vi.fn(async()=>true);
  const session=new AgentToolSession({dispatch,verifyChange,availableTools:new Set(["host_stat","host_read_file","host_diagnostics_batch"]),onEvent:()=>{}});
  sessions.push(session);return {session,dispatch,verifyChange};
}
// Observe only the bounded ledger facts at issue, rather than adding a public introspection API.
type Ledger={failure?:string;retryable?:boolean;policyBlocks:number;transportRetries:number;busy:boolean;changes:Set<string>};
function ledger(session:AgentToolSession,target="a"):Ledger|undefined {
  const key=createHash("sha256").update(JSON.stringify(["inspect",target])).digest("hex");
  return (session as unknown as {attempts:Map<string,Ledger>}).attempts.get(key);
}
async function seedArgumentHistory(session:AgentToolSession,dispatch:ReturnType<typeof fixture>["dispatch"]) {
  dispatch.mockResolvedValueOnce({ok:false,error:{code:"ARGUMENT",retryable:false}});
  expect((await session.execute(op("seed"))).errorClass).toBe("ARGUMENT");
}
afterEach(()=>{sessions.splice(0).forEach(s=>s.close());});

describe("final R2 diagnostic singleton aggregate transport ledger",()=>{
  it("M1 dispatched aggregate loss replaces stale argument history with retryable TRANSPORT",async()=>{
    const {session,dispatch}=fixture();await seedArgumentHistory(session,dispatch);
    dispatch.mockRejectedValueOnce(timeout());
    expect((await session.diagnostics(op("loss",{change:{kind:"argument",evidenceId:"corrected"}}),[member()]))[0]).toMatchObject({status:"failed",errorClass:"TRANSPORT",reason:"BATCH_RESULT_UNAVAILABLE"});
    expect(ledger(session)).toMatchObject({failure:"TRANSPORT",retryable:true,policyBlocks:0,transportRetries:0,busy:false});
    expect(session.snapshot()).toMatchObject({active_intents:0,in_flight:0});
    expect(dispatch).toHaveBeenCalledTimes(2);
  });
  it("M2 verified aggregate transport retries stop at the existing two-retry ceiling",async()=>{
    const {session,dispatch}=fixture();dispatch.mockRejectedValueOnce(timeout());
    await session.execute(op("seed"));dispatch.mockRejectedValue(timeout());
    for(let i=1;i<=2;i++) {
      expect((await session.diagnostics(op("retry"+i,{change:transportChange("e"+i)}),[member()]))[0]).toMatchObject({status:"failed",errorClass:"TRANSPORT",reason:"BATCH_RESULT_UNAVAILABLE"});
      expect(ledger(session)).toMatchObject({failure:"TRANSPORT",retryable:true,transportRetries:i,policyBlocks:0,busy:false});
    }
    expect((await session.diagnostics(op("exhausted",{change:transportChange("e3")}),[member()]))[0]).toMatchObject({status:"suppressed",reason:"EQUIVALENT_RETRY"});
    expect(dispatch).toHaveBeenCalledTimes(3);
  });
  it("M3 a fresh sibling in the guarded batch retains only its actual aggregate TRANSPORT failure",async()=>{
    const {session,dispatch}=fixture();dispatch.mockResolvedValueOnce({ok:false,error:{code:"BACKEND_POLICY",retryable:false}});
    await session.execute(op("denied"));
    dispatch.mockRejectedValueOnce(timeout()).mockResolvedValueOnce(ok({operations:[ok({size:1})],failed:0}));
    const result=await session.diagnostics(op("batch"),[member(),member("b"),member("c")]);
    expect(result.map(x=>x.status)).toEqual(["suppressed","failed","succeeded"]);
    expect(ledger(session,"a")).toMatchObject({failure:"BACKEND_POLICY",policyBlocks:1});
    expect(ledger(session,"b")).toMatchObject({failure:"TRANSPORT",retryable:true,policyBlocks:0,transportRetries:0,busy:false});
    expect(ledger(session,"c")).toBeUndefined();expect(session.snapshot().active_intents).toBe(0);
    expect((await session.execute(op("same-b",{target:"b",authorization:"new-label",call:{name:"host_read_file",arguments:{path:"b"}}}))).reason).toBe("EQUIVALENT_RETRY");
    expect(dispatch).toHaveBeenCalledTimes(3);
    dispatch.mockResolvedValueOnce(ok({size:1}));expect((await session.execute(op("independent-c",{target:"c"}))).status).toBe("succeeded");
  });
  it("M4 verified recovery retains retry count/evidence and cannot reset the ceiling",async()=>{
    const {session,dispatch,verifyChange}=fixture();await seedArgumentHistory(session,dispatch);
    dispatch.mockRejectedValueOnce(timeout());await session.diagnostics(op("loss",{change:{kind:"argument",evidenceId:"fixed"}}),[member()]);
    dispatch.mockResolvedValueOnce(ok({operations:[ok({size:1})],failed:0}));
    expect((await session.diagnostics(op("recovered",{change:transportChange("restored")}),[member()]))[0].status).toBe("succeeded");
    expect(verifyChange).toHaveBeenLastCalledWith(expect.objectContaining({change:transportChange("restored")}),{authorization:"a",failure:"TRANSPORT"});
    expect(ledger(session)).toMatchObject({failure:undefined,transportRetries:1,policyBlocks:0,busy:false});
    expect(ledger(session)!.changes.size).toBe(2);
    dispatch.mockRejectedValue(timeout());await session.diagnostics(op("lost-again"),[member()]);
    expect((await session.diagnostics(op("replayed-evidence",{change:transportChange("restored")}),[member()]))[0].reason).toBe("EQUIVALENT_RETRY");
    await session.diagnostics(op("last-retry",{change:transportChange("fresh")}),[member()]);
    expect(ledger(session)!.transportRetries).toBe(2);
    expect((await session.diagnostics(op("exhausted",{change:transportChange("extra")}),[member()]))[0].reason).toBe("EQUIVALENT_RETRY");
    expect(dispatch).toHaveBeenCalledTimes(5);
  });
  it.each([{}, {operations:[]}, {operations:[ok({}),ok({})]}])("M5 incomplete non-transport aggregate %j preserves prior history and blocks children",async result=>{
    const {session,dispatch}=fixture();await seedArgumentHistory(session,dispatch);
    dispatch.mockResolvedValueOnce(ok(result));
    const batch=session.diagnostics(op("incomplete",{change:{kind:"argument",evidenceId:"fixed"}}),[member()]);
    const child=session.execute(op("child",{intent:"child",dependsOn:["incomplete"]}));
    expect((await batch)[0]).toMatchObject({status:"failed",reason:"BATCH_RESULT_UNAVAILABLE"});
    expect((await child).reason).toBe("DEPENDENCY_NOT_SUCCESSFUL");
    expect(ledger(session)).toMatchObject({failure:"ARGUMENT",retryable:false,policyBlocks:0,transportRetries:0,busy:false});
    expect(dispatch).toHaveBeenCalledTimes(2);
  });
});
