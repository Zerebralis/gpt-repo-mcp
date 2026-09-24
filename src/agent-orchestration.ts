import { createHash } from "node:crypto";
import { checkResult, classifyError, record, type ErrorClass } from "./orchestration/result.js";
import { ProgressTracker, type ProgressEvent, type CapacityScope, PROGRESS_LIMITS } from "./orchestration/progress.js";
export { AGENT_ORCHESTRATION_INSTRUCTIONS } from "./orchestration/instructions.js";
export { checkResult, classifyError } from "./orchestration/result.js";

export type ToolCall = { name: string; arguments: Record<string, unknown> };
export type Change = { kind: "approval" | "argument" | "transport" | "capability"; evidenceId: string };
export type Operation = {
  id: string; subtask: string; intent: string; target: string; authorization: string;
  call: ToolCall; mutating: boolean; dependsOn?: string[];
  requiredFields?: string[]; expectedExitCodes?: number[];
  change?: Change; longRunning?: boolean; jobStart?: ToolCall;
  /** Supplied by the trusted caller after checking full semantics and authorization. */
  structuredAlternative?: ToolCall;
};
export type Outcome = {
  status: "succeeded" | "running" | "failed" | "suppressed" | "ambiguous";
  value?: Record<string, unknown>; errorClass?: ErrorClass; reason?: string; result_retained?: false;
};
type Attempt = { attempts: number; policyBlocks: number; transportRetries: number; authorization: string;
  failure?: ErrorClass; retryable?: boolean; busy: boolean; ambiguous: boolean; activeJob?: boolean; changes: Set<string> };
type Job = { id: string; operation: Operation; nextPoll: number; interval: number; polling: boolean };
const POLICY = new Set<ErrorClass>(["UPSTREAM_AUTO_REVIEW","BACKEND_POLICY","LOCAL_EXEC_POLICY"]);
const fingerprint = (intent: string,target: string) => hash(JSON.stringify([intent,target]));
const hash = (v: string) => createHash("sha256").update(v).digest("hex");

export const SESSION_LIMITS = {in_flight:64,jobs:32,active_intents:128,history:4096,terminal:100_000,...PROGRESS_LIMITS};
export type SessionLimits = typeof SESSION_LIMITS;

/** A bounded caller adapter, not a server, authorization authority or persistent workflow engine. */
export class AgentToolSession {
  readonly progress: ProgressTracker;
  private readonly attempts = new Map<string,Attempt>();
  private readonly outcomes = new Map<string,Outcome>();
  private readonly pending = new Map<string,Promise<Outcome>>();
  private readonly jobs = new Map<string,Job>();
  private readonly identities = new Map<string,string>();
  private readonly reported = new Set<string>();
  private state: "active" | "closing" | "closed" = "active";
  private jobReservations = 0;
  private helperLeases = 0;
  private readonly limits: SessionLimits;
  private readonly now: () => number;
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(private readonly options: {
    dispatch: (call: ToolCall, request: {signal:AbortSignal;timeoutMs:number}) => Promise<unknown>;
    availableTools: ReadonlySet<string>;
    onEvent: (event: ProgressEvent) => void;
    /** Trusted integration verifies evidence, not an LLM-supplied boolean. Default denies retries. */
    verifyChange?: (operation: Operation, previous: Readonly<{authorization:string;failure?:ErrorClass}>) => Promise<boolean>;
    now?: () => number; requestTimeoutMs?: number; limits?: Partial<SessionLimits>;
  }) {
    this.now = options.now ?? Date.now;
    this.limits = {...SESSION_LIMITS,...options.limits};
    for(const key of Object.keys(SESSION_LIMITS) as Array<keyof SessionLimits>) {
      if(!Number.isInteger(this.limits[key]) || this.limits[key]<1 || this.limits[key]>SESSION_LIMITS[key])throw new Error("Invalid session capacity: "+key);
    }
    this.progress = new ProgressTracker(options.onEvent,this.now,this.limits);
    this.timer = setInterval(() => this.progress.tick(), 1_000);
    this.timer.unref();
  }
  /** Terminal admission stop. Already dispatched observations settle naturally; no host cancellation claim. */
  close(): void {
    if(this.state==="active") {
      this.state="closing";
      clearInterval(this.timer);
      this.progress.closing(this.pending.size>0 || this.jobs.size>0 || this.helperLeases>0 || [...this.attempts.values()].some(a=>a.ambiguous));
      this.progress.close();
    }
    this.settleClosed();
  }
  snapshot() {
    return {state:this.state,in_flight:this.pending.size,terminal_records:this.outcomes.size,identities:this.identities.size,
      retained_full_results:0,active_intents:[...this.attempts.values()].filter(a=>a.busy||a.activeJob).length,
      history_intents:this.attempts.size,job_reservations:this.jobReservations,
      jobs:[...this.jobs.entries()].map(([id,j])=>({operation_id:id,job_id:j.id,polling:j.polling,mutating:j.operation.mutating})),
      ambiguous_intents:[...this.attempts.entries()].filter(([,a])=>a.ambiguous).map(([id])=>id),
      rollover_supported:false,progress:this.progress.snapshot()};
  }
  private settleClosed(): void {
    if(this.state==="closing" && !this.pending.size && !this.helperLeases && ![...this.jobs.values()].some(j=>j.polling))this.state="closed";
  }
  private capacity(scope: CapacityScope,used:number,requested=1): Outcome | undefined {
    return this.progress.capacity(scope,used,this.limits[scope],requested)?undefined:{status:"suppressed",reason:"WORKFLOW_CAPACITY:"+scope};
  }
  private retire(key:string): void {
    const a=this.attempts.get(key);
    if(a && !a.busy && !a.activeJob && !a.ambiguous && !a.failure && !a.policyBlocks && !a.transportRetries && !a.changes.size)this.attempts.delete(key);
  }

  execute(operation: Operation): Promise<Outcome> {
    if(this.state!=="active")return Promise.resolve({status:"suppressed",reason:"SESSION_CLOSED"});
    // Copy before asynchronous work: caller mutation must not change the dispatched effect.
    const op = structuredClone(operation);
    const identity=hash(JSON.stringify(op));
    const operationKey=hash(op.id);
    if(this.identities.has(operationKey) && this.identities.get(operationKey)!==identity) return Promise.resolve({status:"suppressed",reason:"OPERATION_ID_REUSED"});
    if (this.pending.has(operationKey)) return this.pending.get(operationKey)!.then(value=>structuredClone(value));
    if(this.outcomes.has(operationKey))return Promise.resolve({...this.outcomes.get(operationKey)!});
    if(!this.progress.ready())return Promise.resolve({status:"suppressed",reason:"WORKFLOW_CAPACITY:event_queue"});
    const denied=this.capacity("in_flight",this.pending.size) ?? this.capacity("terminal",this.identities.size);
    if(denied)return Promise.resolve(denied);
    if(!this.progress.lane(op.subtask,op.intent,op.target))return Promise.resolve({status:"suppressed",reason:"WORKFLOW_CAPACITY:lanes"});
    if(this.state!=="active")return Promise.resolve({status:"suppressed",reason:"SESSION_CLOSED"});
    this.identities.set(operationKey,identity);
    const missingDependency = op.dependsOn?.some(id=>!this.identities.has(hash(id)));
    const promise = Promise.resolve().then(() => missingDependency ? this.finish(op,{status:"suppressed",reason:"DEPENDENCY_UNKNOWN"}) : this.run(op))
      .finally(()=>{this.pending.delete(operationKey);this.settleClosed();});
    this.pending.set(operationKey,promise);
    return promise.then(value => structuredClone(value));
  }

  private async run(op: Operation): Promise<Outcome> {
    if(this.state!=="active")return this.finish(op,{status:"suppressed",reason:"SESSION_CLOSED"});
    for (const parent of op.dependsOn ?? []) {
      if (parent === op.id || !this.identities.has(hash(parent))) return this.finish(op,{status:"suppressed",reason:"DEPENDENCY_UNKNOWN"});
      await this.pending.get(hash(parent));
      if (this.outcomes.get(hash(parent))?.status !== "succeeded") return this.finish(op,{status:"suppressed",reason:"DEPENDENCY_NOT_SUCCESSFUL"});
    }
    if(this.state!=="active")return this.finish(op,{status:"suppressed",reason:"SESSION_CLOSED"});
    const key = fingerprint(op.intent,op.target);
    let attempt = this.attempts.get(key);
    if (!attempt) {
      const denied=this.capacity("active_intents",[...this.attempts.values()].filter(a=>a.busy||a.activeJob).length) ?? this.capacity("history",this.attempts.size);
      if(denied)return this.finish(op,denied);
      attempt = {attempts:0,policyBlocks:0,transportRetries:0,authorization:op.authorization,busy:false,ambiguous:false,changes:new Set()};
      this.attempts.set(key,attempt);
    }
    if (attempt.busy || attempt.activeJob || attempt.ambiguous) return this.finish(op,{status:"suppressed",reason:attempt.busy?"INTENT_IN_FLIGHT":"RECONCILE_REQUIRED"});
    const activeDenied=this.capacity("active_intents",[...this.attempts.values()].filter(a=>a.busy||a.activeJob).length);
    if(activeDenied){this.retire(key);return this.finish(op,activeDenied);}
    attempt.busy = true;
    let reservedJob=false;
    try {
      if (attempt.failure) {
        const changed = op.change && !attempt.changes.has(hash(op.change.evidenceId)) &&
          (op.change.kind !== "approval" || op.authorization !== attempt.authorization) &&
          await this.options.verifyChange?.(structuredClone(op),{authorization:attempt.authorization,failure:attempt.failure}).catch(()=>false);
        const policy = POLICY.has(attempt.failure);
        const permittedKind = policy ? ["approval","capability"].includes(op.change?.kind ?? "") :
          attempt.failure === "TRANSPORT" ? op.change?.kind === "transport" && attempt.retryable && attempt.transportRetries < 2 :
          attempt.failure === "ARGUMENT" ? op.change?.kind === "argument" :
          ["AUTH","APPROVAL_PENDING"].includes(attempt.failure) && op.change?.kind === "approval";
        if (!changed || !permittedKind || attempt.policyBlocks >= 2) return this.finish(op,{status:"suppressed",errorClass:attempt.failure,reason:"EQUIVALENT_RETRY"});
        attempt.changes.add(hash(op.change!.evidenceId));
        if (attempt.failure === "TRANSPORT") attempt.transportRetries++;
      }
      if(this.state!=="active")return this.finish(op,{status:"suppressed",reason:"SESSION_CLOSED"});
      let call = op.structuredAlternative && this.options.availableTools.has(op.structuredAlternative.name) ? op.structuredAlternative : op.call;
      if(call.name==="host_shell" && typeof call.arguments.timeout_ms==="number" && call.arguments.timeout_ms>=60_000)op.longRunning=true;
      if (op.longRunning) {
        if (!op.jobStart || !["host_process_start","host_review_runtime"].includes(op.jobStart.name) || !this.options.availableTools.has("host_process_output")) return this.finish(op,{status:"suppressed",reason:"JOB_START_REQUIRED"});
        const denied=this.capacity("jobs",this.jobs.size+this.jobReservations);
        if(denied)return this.finish(op,denied);
        this.jobReservations++;reservedJob=true;
        call = op.jobStart;
      }
      if (!this.options.availableTools.has(call.name)) return this.finish(op,{status:"suppressed",reason:"CAPABILITY_UNAVAILABLE"});
      attempt.attempts++; attempt.authorization = op.authorization;
      this.progress.event(op.subtask,{type:"attempt",attempt:attempt.attempts,material_progress:false,changed_condition:op.change?.kind});
      if(this.state!=="active")return this.finish(op,{status:"suppressed",reason:"SESSION_CLOSED"});
      let checked;
      try { checked = checkResult(await this.dispatch(call),op.longRunning? ["job_id","status"] : op.requiredFields,op.expectedExitCodes); }
      catch (error) { checked = {ok:false,errorClass:classifyError(error),retryable:classifyError(error)==="TRANSPORT",value:undefined}; }
      if (!checked.ok) {
        attempt.failure = checked.errorClass ?? "UNKNOWN"; attempt.retryable = checked.retryable;
        if (POLICY.has(attempt.failure)) attempt.policyBlocks++;
        attempt.ambiguous = op.mutating && ["TRANSPORT","UNKNOWN"].includes(attempt.failure);
        if(op.longRunning && typeof checked.value?.job_id==="string" && checked.value.job_id) {
          this.jobs.set(op.id,{id:checked.value.job_id,operation:op,nextPoll:this.now()+5_000,interval:5_000,polling:false});
          attempt.activeJob=true;
        }
        const value = {status:attempt.ambiguous?"ambiguous":"failed",errorClass:attempt.failure,value:checked.value} as Outcome;
        this.block(op,attempt,attempt.ambiguous?"reconcile":"resolve_prerequisite");
        return this.finish(op,value);
      }
      attempt.failure = undefined;
      if (op.longRunning) {
        const id = checked.value?.job_id;
        if (typeof id !== "string" || !id) {
          attempt.ambiguous = op.mutating;
          this.block(op,attempt,"reconcile");
          return this.finish(op,{status:"ambiguous",reason:"INVALID_JOB_ID"});
        }
        this.jobs.set(op.id,{id,operation:op,nextPoll:this.now()+5_000,interval:5_000,polling:false});
        attempt.activeJob = true;
        // Starting is not completing the prerequisite, even for fast jobs.
        this.progress.event(op.subtask,{type:"job",job_status:"running",material_progress:true,blocker:false});
        this.progress.pause(op.subtask,true);
        return this.finish(op,{status:"running",value:checked.value});
      }
      // Explicit evidence required for read progress; unchanged successful polls are not progress.
      if (op.mutating) this.progress.progress(op.subtask,op.id);
      return this.finish(op,{status:"succeeded",value:checked.value});
    } finally { attempt.busy = false; if(reservedJob)this.jobReservations--; this.retire(key); }
  }

  /** One bounded status+output call; scheduler does other work until next_poll_ms. */
  async poll(operationId: string): Promise<Outcome & {next_poll_ms?:number}> {
    if(this.state!=="active")return {status:"suppressed",reason:"SESSION_CLOSED"};
    const job = this.jobs.get(operationId);
    if (!job) return {status:"suppressed",reason:"UNKNOWN_JOB"};
    if (job.polling || this.now() < job.nextPoll) return {status:"running",next_poll_ms:job.nextPoll};
    job.polling = true;
    try {
      let checked;
      try { checked = checkResult(await this.dispatch({name:"host_process_output",arguments:{job_id:job.id}}),["job_id","status"],job.operation.expectedExitCodes); }
      catch (error) { checked = {ok:false,errorClass:classifyError(error),value:undefined}; }
      job.interval = Math.min(30_000,job.interval*2); job.nextPoll = this.now()+job.interval;
      if (!checked.ok && checked.value?.job_id === job.id && ["exited","failed","killed","timed_out"].includes(String(checked.value.status))) {
        this.jobs.delete(operationId);
        const attempt = this.attempts.get(fingerprint(job.operation.intent,job.operation.target))!;
        attempt.activeJob = false; attempt.failure = checked.errorClass ?? "UNKNOWN";
        this.progress.pause(job.operation.subtask,false);
        this.block(job.operation,attempt,"reconcile");
        return this.finish(job.operation,{status:"failed",errorClass:attempt.failure,value:checked.value});
      }
      if (!checked.ok || checked.value?.job_id !== job.id) {
        const attempt = this.attempts.get(fingerprint(job.operation.intent,job.operation.target))!;
        attempt.ambiguous = job.operation.mutating;
        this.block(job.operation,attempt,"reconcile");
        return {status:"ambiguous",errorClass:checked.errorClass,reason:"JOB_RECONCILE_REQUIRED",next_poll_ms:job.nextPoll};
      }
      const status = checked.value.status;
      if (status === "running") return {status:"running",next_poll_ms:job.nextPoll};
      if (status !== "exited" || typeof checked.value.exit_code !== "number") return {status:"ambiguous",reason:"JOB_TERMINAL_STATE_UNKNOWN",next_poll_ms:job.nextPoll};
      this.jobs.delete(operationId);
      this.progress.pause(job.operation.subtask,false);
      const attempt = this.attempts.get(fingerprint(job.operation.intent,job.operation.target))!;
      attempt.ambiguous = false;
      attempt.activeJob = false;
      this.progress.progress(job.operation.subtask,operationId+":completed");
      this.progress.event(job.operation.subtask,{type:"job",job_status:"exited",material_progress:true,blocker:false});
      attempt.failure=undefined;
      this.retire(fingerprint(job.operation.intent,job.operation.target));
      return this.finish(job.operation,{status:"succeeded",value:checked.value});
    } finally { job.polling = false; this.settleClosed(); }
  }

  /** Independent known paths only; lazy/derived paths belong in a subsequent execute call. */
  async readFiles(op: Omit<Operation,"call"|"mutating">, files: Array<{path:string;offset?:number;length:number}>, partialBatchAvailable: boolean): Promise<Outcome[]> {
    if(this.state!=="active")return [{status:"suppressed",reason:"SESSION_CLOSED"}];
    op=structuredClone(op);files=structuredClone(files);
    if (op.dependsOn?.length || !files.length || files.some(f=>typeof f.path!=="string" || !f.path || !Number.isInteger(f.length) || f.length<=0)) {
      return [{status:"suppressed",reason:"READ_BATCH_REQUIRES_INDEPENDENT_KNOWN_PATHS"}];
    }
    const total = files.reduce((n,f)=>n+f.length,0);
    const keys=files.map(f=>fingerprint(op.intent,f.path));
    const hasHistory=keys.some(key=>{const a=this.attempts.get(key);return a && (a.failure || a.busy || a.ambiguous || a.activeJob || a.policyBlocks || a.transportRetries || a.changes.size);});
    if (hasHistory || new Set(keys).size!==keys.length || files.length>20 || total>4*1024*1024 || !partialBatchAvailable || !this.options.availableTools.has("host_read_many")) {
      return Promise.all(files.map((file,i)=>this.execute({...op,id:op.id+":"+i,target:file.path,call:{name:"host_read_file",arguments:file},mutating:false,requiredFields:["content"]})));
    }
    const denied=this.capacity("active_intents",[...this.attempts.values()].filter(a=>a.busy||a.activeJob).length,keys.length+1) ?? this.capacity("history",this.attempts.size,keys.length+1);
    if(denied)return [denied];
    if(this.state!=="active")return [{status:"suppressed",reason:"SESSION_CLOSED"}];
    this.helperLeases++;
    for(const key of keys)this.attempts.set(key,{attempts:1,policyBlocks:0,transportRetries:0,authorization:op.authorization,busy:true,ambiguous:false,changes:new Set()});
    try {
      const batch = await this.execute({...op,target:JSON.stringify(files.map(f=>f.path)),call:{name:"host_read_many",arguments:{files,max_total_bytes:total,continue_on_error:true}},mutating:false,requiredFields:["files"]});
      const outcomes:Outcome[] = !Array.isArray(batch.value?.files) || batch.value.files.length!==files.length ? files.map(()=>({status:"failed",errorClass:batch.errorClass??"UNKNOWN",reason:"INCOMPLETE_BATCH"})) : batch.value.files.map((item:unknown)=>{
        const r=record(item); const checked=checkResult(r?.ok===false?r:{ok:true,result:r},["content"]);
        return {status:checked.ok?"succeeded":"failed",value:checked.value,errorClass:checked.errorClass};
      });
      outcomes.forEach((outcome,i)=>{if(outcome.status!=="succeeded") {
        const attempt=this.attempts.get(keys[i])!;attempt.failure=outcome.errorClass??"UNKNOWN";
        if(POLICY.has(attempt.failure))attempt.policyBlocks++;
      }});
      return outcomes;
    } finally { for(const key of keys){this.attempts.get(key)!.busy=false;this.retire(key);} this.helperLeases--;this.settleClosed(); }
  }

  async diagnostics(op: Omit<Operation,"call"|"mutating">, operations: Array<{tool:string;args:Record<string,unknown>}>): Promise<Outcome[]> {
    if(this.state!=="active")return [{status:"suppressed",reason:"SESSION_CLOSED"}];
    op=structuredClone(op);operations=structuredClone(operations);
    const allowed = new Set(["system_info","system_processes","system_process_detail","system_process_tree","network_listeners","port_owner","task_list","task_get","eventlog_query","http_probe","stat","file_hash"]);
    if (op.dependsOn?.length || !operations.length || operations.length>16 || operations.some(x=>!allowed.has(x.tool))) return [{status:"suppressed",reason:"UNSUPPORTED_DIAGNOSTIC_BATCH"}];
    const batch = await this.execute({...op,call:{name:"host_diagnostics_batch",arguments:{operations}},mutating:false,requiredFields:["operations"]});
    if (!Array.isArray(batch.value?.operations) || batch.value.operations.length!==operations.length) return operations.map(()=>({status:"failed",reason:"INCOMPLETE_BATCH"}));
    return batch.value.operations.map((item:unknown)=>{const r=record(item);const c=checkResult(r);return {status:c.ok?"succeeded":"failed",value:c.value,errorClass:c.errorClass};});
  }

  private async dispatch(call: ToolCall): Promise<unknown> {
    const timeoutMs = Math.min(60_000,Math.max(1,this.options.requestTimeoutMs??30_000));
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.options.dispatch(call,{signal:controller.signal,timeoutMs}),
        new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Object.assign(new Error("Tool response deadline"),{code:"ETIMEDOUT"}));},timeoutMs);})
      ]);
    } finally { if(timer)clearTimeout(timer); }
  }

  private block(op: Operation,attempt: Attempt,next: "reconcile"|"resolve_prerequisite"): void {
    const key = hash(JSON.stringify([op.subtask,op.intent,op.target,attempt.failure,attempt.policyBlocks,next]));
    if (this.reported.has(key)) return;
    this.reported.add(key);
    this.progress.event(op.subtask,{type:"blocker",blocker:true,error_class:attempt.failure??"UNKNOWN",attempt:attempt.attempts,
      material_progress:false,next_action:next,changed_condition:op.change?.kind??"missing"});
  }
  private finish(op: Operation,value: Outcome): Outcome {
    // Keep identity and dependency truth, never a full terminal payload or fulfilled Promise.
    this.outcomes.set(hash(op.id),{status:value.status,errorClass:value.errorClass,reason:value.reason,result_retained:false});
    return value;
  }
}
