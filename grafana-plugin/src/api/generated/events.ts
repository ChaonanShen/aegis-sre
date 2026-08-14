/* Generated from api/events.schema.json. Do not edit directly. */

export type BusinessId = string;

/**
 * Stable SSE envelope. Provider-native events must be normalized before crossing this boundary.
 */
export interface AegisEvent {
  event_id: BusinessId;
  event_type:
    | "message.delta"
    | "tool.started"
    | "tool.completed"
    | "approval.requested"
    | "approval.resolved"
    | "artifact.created"
    | "turn.started"
    | "turn.completed"
    | "turn.failed"
    | "run.updated";
  session_id?: BusinessId;
  turn_id?: BusinessId;
  run_id?: BusinessId;
  sequence: number;
  occurred_at: string;
  payload:
    | MessageDelta
    | ToolStarted
    | ToolCompleted
    | ApprovalRequested
    | ApprovalResolved
    | ArtifactCreated
    | TurnStarted
    | TurnCompleted
    | TurnFailed
    | RunUpdated;
}
export interface MessageDelta {
  delta: string;
}
export interface ToolStarted {
  call_id: BusinessId;
  server: string;
  tool: string;
  arguments: {
    [k: string]: unknown;
  };
  access: "read" | "write" | "execute";
}
export interface ToolCompleted {
  call_id: BusinessId;
  status: "succeeded" | "failed";
  summary?: string;
  duration_ms: number;
}
export interface ApprovalRequested {
  approval_id: BusinessId;
  action: string;
  reason: string;
  risk: "medium" | "high" | "critical";
  preview?: string[];
}
export interface ApprovalResolved {
  approval_id: BusinessId;
  decision: "approved" | "rejected";
  reason?: string;
}
export interface ArtifactCreated {
  artifact_id: BusinessId;
  name: string;
  media_type: string;
  size_bytes: number;
}
export interface TurnStarted {
  status: "running";
}
export interface TurnCompleted {
  status: "succeeded" | "interrupted";
}
export interface TurnFailed {
  code: string;
  message: string;
  retryable: boolean;
}
export interface RunUpdated {
  status: "queued" | "running" | "waiting_for_input" | "waiting_for_approval" | "succeeded" | "failed" | "cancelled";
  step_id?: string;
  summary?: string;
}
