import { createHash } from "node:crypto";
import type { ErrorClass } from "./result.js";

export type CapacityScope = "in_flight" | "jobs" | "active_intents" | "history" | "terminal" | "lanes" | "evidence" | "event_queue";
export type ProgressEvent = {
  type: "attempt" | "blocker" | "progress" | "stall_check" | "status_update" | "job" | "capacity_block" | "capacity_warning" | "session_closed";
  subtask_id: string; intent: string; target: string; attempt: number;
  error_class?: ErrorClass; material_progress: boolean; blocker: boolean;
  last_success?: string; next_action?: "reconcile" | "resolve_prerequisite" | "inspect" | "wait" | "drain" | "finish_workflow";
  changed_condition?: string; job_status?: string;
  scope?: CapacityScope; limit?: number; used?: number; dropped_events?: number;
};
export type ProgressLimits = { lanes: number; evidence: number; event_queue: number };
export const PROGRESS_LIMITS: ProgressLimits = {lanes:256,evidence:100_000,event_queue:256};
type Lane = { elapsed: number; at: number; paused: boolean; stage: number; last?: string; event: ProgressEvent };
const digest = (v: string) => createHash("sha256").update(v).digest("hex");
const neutral = (): ProgressEvent => ({type:"capacity_block",subtask_id:"session",intent:"capacity",target:"session",attempt:0,material_progress:false,blocker:true});

/** Exact compact evidence history, bounded delivery queue and per-subtask active time. */
export class ProgressTracker {
  private readonly lanes = new Map<string, Lane>();
  private readonly evidence = new Set<string>();
  private readonly undelivered: ProgressEvent[] = [];
  private readonly capacitySignals = new Set<string>();
  private overflow = 0;
  private closed = false;
  constructor(private readonly emit: (event: ProgressEvent) => void, private readonly now = Date.now,
    private readonly limits: ProgressLimits = PROGRESS_LIMITS) {}

  capacity(scope: CapacityScope, used: number, limit: number, requested = 1): boolean {
    const blocked = used + requested > limit;
    const warning = used + requested >= Math.ceil(limit * 0.9);
    if (!blocked) this.capacitySignals.delete(scope+":block");
    if (!warning) this.capacitySignals.delete(scope+":warning");
    if (blocked || warning) {
      const key = scope+(blocked?":block":":warning");
      if (!this.capacitySignals.has(key)) {
        this.capacitySignals.add(key);
        const next = scope === "event_queue" ? "drain" : ["in_flight","active_intents"].includes(scope) ? "wait" : scope === "jobs" ? "reconcile" : "finish_workflow";
        this.deliver({...neutral(),type:blocked?"capacity_block":"capacity_warning",blocker:blocked,scope,used,limit,next_action:next});
      }
    }
    return !blocked;
  }
  ready(): boolean { return this.capacity("event_queue",this.undelivered.length,this.limits.event_queue); }
  lane(id: string, intent: string, target: string): boolean {
    if(this.closed)return false;
    const key=digest(id);
    const existing=this.lanes.get(key);
    if(existing) {existing.event.intent=digest(intent);existing.event.target=digest(target);return true;}
    if (!this.capacity("lanes",this.lanes.size,this.limits.lanes)) return false;
    this.lanes.set(key, { elapsed: 0, at: this.now(), paused: false, stage: 0,
      event: {type:"attempt",subtask_id:key,intent:digest(intent),target:digest(target),attempt:0,material_progress:false,blocker:false} });
    return true;
  }
  event(id: string, patch: Partial<ProgressEvent>): void {
    if(this.closed)return;
    const lane = this.lanes.get(digest(id)); if (!lane) return;
    lane.event = {...lane.event, ...patch, last_success:lane.last};
    this.deliver({...lane.event});
  }
  private deliver(event: ProgressEvent): void {
    try { this.emit({...event}); }
    catch {
      if (this.undelivered.length < this.limits.event_queue) this.undelivered.push({...event});
      else this.overflow++; // One reserved, coalesced overflow receipt survives a full queue.
    }
  }
  drainUndelivered(): ProgressEvent[] {
    const events=this.undelivered.splice(0);
    if(this.overflow)events.push({...neutral(),scope:"event_queue",limit:this.limits.event_queue,used:this.limits.event_queue,next_action:"drain",dropped_events:this.overflow});
    this.overflow=0;this.capacitySignals.delete("event_queue:block");this.capacitySignals.delete("event_queue:warning");
    return events;
  }
  progress(id: string, evidenceId: string, effect?: Pick<ProgressEvent,"intent"|"target">): boolean {
    if(this.closed)return false;
    const lane = this.lanes.get(digest(id)); if (!lane) return false;
    const fingerprint = digest(JSON.stringify([id,evidenceId]));
    if (this.evidence.has(fingerprint)) return false;
    if (!this.capacity("evidence",this.evidence.size,this.limits.evidence)) return false;
    this.evidence.add(fingerprint); lane.last = fingerprint;
    lane.elapsed = 0; lane.at = this.now(); lane.stage = 0;
    this.event(id, {...effect,type:"progress",material_progress:true,blocker:false,error_class:undefined,next_action:undefined});
    return true;
  }
  pause(id: string, paused: boolean): void {
    const lane = this.lanes.get(digest(id)); if (!lane || this.closed) return;
    this.accrue(lane); lane.paused = paused;
  }
  tick(): void {
    if(this.closed)return;
    for (const lane of this.lanes.values()) {
      this.accrue(lane); if (lane.paused) continue;
      if (lane.elapsed >= 180_000 && lane.stage < 1) { lane.stage = 1; this.deliver({...lane.event,type:"stall_check",material_progress:false,last_success:lane.last}); }
      if (lane.elapsed >= 300_000 && lane.stage < 2) { lane.stage = 2; this.deliver({...lane.event,type:"status_update",material_progress:false,next_action:"inspect",last_success:lane.last}); }
    }
  }
  close(): void {this.closed=true;}
  snapshot() {return {lanes:this.lanes.size,evidence:this.evidence.size,queued_events:this.undelivered.length,dropped_events:this.overflow,closed:this.closed};}
  closing(reconcile: boolean): void {this.deliver({...neutral(),type:"session_closed",blocker:reconcile,next_action:reconcile?"reconcile":"finish_workflow"});}
  private accrue(lane: Lane): void {
    const now = this.now(); if (!lane.paused) lane.elapsed += Math.max(0,now-lane.at); lane.at = now;
  }
}
