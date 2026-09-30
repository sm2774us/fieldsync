export interface Ready { ready: boolean; audit_entries: number; audit_error: string | null }
export interface ChainStatus { ok: boolean; entries: number; head_hash: string; checkpoints_verified: number; error: string | null }
export interface ServiceKey { key_id: string; public_key: string; alg: string }
export type Connectivity = "online" | "delayed" | "offline" | "never";
export interface Device {
  device_id: string; label: string; agency_id: string; status: "pending" | "active" | "revoked";
  sync_state: "ok" | "blocked"; blocked_seq: number | null; acked_seq: number; last_seen_ms: number | null;
  connectivity: Connectivity; queue_depth: number | null; oldest_pending_age_s: number | null;
  storage_free_bytes: number | null; storage_total_bytes: number | null; app_version: string | null; retries: number | null;
}
export interface ServerEvent {
  device_id: string; seq: number; op_id: string; type: string; schema_version: number; record_id: string;
  ts_ms: number; base_version: number | null; payload: Record<string, unknown>; content_hash: string;
  received_ms: number; batch_id: string;
}
export interface RecordSummary { record_id: string; version: number; data: Record<string, string>; updated_ms: number; created_by: string }
export interface RecordDetail {
  record_id: string; version: number; data: Record<string, string>;
  versions: { version: number; data: Record<string, string>; device_id: string | null; seq: number | null; cause: string; ts_ms: number }[];
  notes: { device_id: string; seq: number; text: string; ts_ms: number }[];
  conflicts: { conflict_id: string; status: string; kind: string }[];
}
export interface Conflict {
  conflict_id: string; record_id: string; device_id: string; seq: number; kind: "stale_base" | "duplicate_create" | "missing_record";
  base_version: number | null; current_version: number | null; status: "open" | "resolved"; created_ms: number;
  resolution: string | null; resolved_by: string | null; proposed: Record<string, unknown>; current: Record<string, string> | null;
}
export interface QuarantineItem {
  quarantine_id: string; device_id: string; seq: number; reason: string; received_ms: number;
  status: "open" | "retry_authorized" | "skip_authorized"; reviewed_by: string | null; review_note: string | null;
  event: Omit<ServerEvent, "device_id" | "received_ms" | "batch_id">; detail: { detail?: string };
}
export interface Alert {
  alert_id: string; ts_ms: number; kind: string; severity: "low" | "medium" | "high" | "critical"; object_id: string | null;
  status: "open" | "acknowledged"; acked_by: string | null; acked_at_ms: number | null; detail: Record<string, unknown>;
}
export interface AuditEntry {
  seq: number; ts_ms: number; actor: string; actor_role: string; action: string; object_type: string;
  object_id: string; object_version: string | null; source_ip: string | null; request_id: string | null;
  detail: Record<string, unknown>; prev_hash: string; entry_hash: string;
}
