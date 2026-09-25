import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentToolSession, AGENT_ORCHESTRATION_INSTRUCTIONS } from "../src/agent-orchestration.js";
import { SERVER_INSTRUCTIONS } from "../src/instructions.js";
import { AGENT_ORCHESTRATION_REFERENCE } from "../src/orchestration/instructions.js";
import { HostBreakglassConfigSchema } from "../src/host-breakglass/config.js";
import { createHostBreakglassContext } from "../src/host-breakglass/context.js";
import { createHostBreakglassMcpServer } from "../src/host-breakglass/register.js";
const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});

async function fixture() {
  const root=await mkdtemp(join(tmpdir(),"agent-orchestration-test-"));
  cleanup.push(()=>rm(root,{recursive:true,force:true}));
  const config=HostBreakglassConfigSchema.parse({enabled:true,mode:"safe",roots:[{id:"fixture",root,read:true,write:true,execute:false}],audit_path:join(root,"audit.jsonl")});
  const server=createHostBreakglassMcpServer(createHostBreakglassContext(config));
  const client=new Client({name:"orchestration-integration",version:"1"});
  const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);
  cleanup.push(async()=>{await client.close();await server.close();});
  const tools=await client.listTools();
  const dispatch=vi.fn((call:Parameters<Client["callTool"]>[0])=>client.callTool(call));
  const session=new AgentToolSession({availableTools:new Set(tools.tools.map(t=>t.name)),dispatch,onEvent:()=>{}});
  cleanup.push(async()=>session.close());
  return {root,client,session,dispatch,tools};
}
const metadata={id:"files",subtask:"files",intent:"read-fixtures",target:"fixtures",authorization:"test"};

describe("orchestration against the real MCP contract",()=>{
  it("publishes the same canonical instructions through MCP and the repo surface",async()=>{
    const {client}=await fixture();
    expect(client.getInstructions()).toContain(AGENT_ORCHESTRATION_INSTRUCTIONS);
    expect(SERVER_INSTRUCTIONS).toContain(AGENT_ORCHESTRATION_REFERENCE);
  });
  it("batches three real file reads in one dispatch and advertises opt-in partial semantics",async()=>{
    const {root,session,dispatch,tools}=await fixture();
    const files=["a","b","c"].map(name=>({path:join(root,name),length:8}));
    await Promise.all(files.map(f=>writeFile(f.path,"data")));
    const schema=tools.tools.find(t=>t.name==="host_read_many")!.inputSchema;
    const result=await session.readFiles(metadata,files,!!schema.properties?.continue_on_error);
    expect(result.map(r=>r.value?.content)).toEqual(["data","data","data"]);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
  it("a refused path returns no content; an independent approved read still succeeds",async()=>{
    const {root,session}=await fixture();await writeFile(join(root,"allowed"),"safe");
    const result=await session.readFiles(metadata,[{path:join(root,"..","not-approved"),length:8},{path:join(root,"allowed"),length:8}],true);
    expect(result[0].status).toBe("failed");expect(result[0].value?.content).toBeUndefined();
    expect(result[1]).toMatchObject({status:"succeeded",value:{content:"safe"}});
  });
  it("retains legacy fail-fast read_many behavior unless explicitly opted in",async()=>{
    const {root,client}=await fixture();await writeFile(join(root,"allowed"),"safe");
    const result=await client.callTool({name:"host_read_many",arguments:{files:[{path:join(root,"missing")},{path:join(root,"allowed")}]}});
    expect(result.isError).toBe(true);
  });
  it("rejects a dependent execution after an actual MCP write error",async()=>{
    const {root,session,dispatch}=await fixture();
    const parent=await session.execute({...metadata,id:"write",mutating:true,call:{name:"host_write_file",arguments:{path:join(root,"absent","file"),content:"fixture"}}});
    // A generic backend error does not attest that no write happened. Keep it ambiguous.
    expect(parent.status).toBe("ambiguous");
    const child=await session.execute({...metadata,id:"execute",intent:"execute",mutating:true,dependsOn:["write"],call:{name:"host_process_start",arguments:{}}});
    expect(child.status).toBe("suppressed");expect(dispatch).toHaveBeenCalledTimes(1);
  });
  it("splits diagnostics using the actual operations/ok/result response contract",async()=>{
    const {root,session}=await fixture();await writeFile(join(root,"allowed"),"safe");
    const result=await session.diagnostics(metadata,[{tool:"stat",args:{path:join(root,"..","not-approved")}},{tool:"stat",args:{path:join(root,"allowed")}}]);
    expect(result.map(r=>r.status)).toEqual(["failed","succeeded"]);
  });
  it("R2 retains an actual denied stat member across individual and alternative dispatch paths",async()=>{
    const {root,session,dispatch}=await fixture();const allowed=join(root,"allowed"),refused=join(root,"..","not-approved");
    await writeFile(allowed,"safe");const intent="inspect-file";
    const result=await session.diagnostics({...metadata,id:"diagnose"},[
      {tool:"stat",args:{path:refused},identity:{intent,target:refused}},
      {tool:"stat",args:{path:allowed},identity:{intent,target:allowed}}
    ]);
    expect(result.map(r=>r.status)).toEqual(["failed","succeeded"]);
    // The existing host batch uses a legacy string error. Do not invent a native BACKEND_POLICY code.
    expect(result[0].errorClass).toBe("UNKNOWN");
    for(const name of ["host_stat","host_read_file"]) {
      const retry=await session.execute({...metadata,id:name,intent,target:refused,mutating:false,call:{name,arguments:{path:refused}}});
      expect(retry).toMatchObject({status:"suppressed",reason:"EQUIVALENT_RETRY"});
    }
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((await session.execute({...metadata,id:"allowed-stat",intent,target:allowed,mutating:false,call:{name:"host_stat",arguments:{path:allowed}}})).status).toBe("succeeded");
    expect(dispatch).toHaveBeenCalledTimes(2);
  });
});
