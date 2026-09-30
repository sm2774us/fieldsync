export type EventState = "local" | "uploading" | "acked" | "failed";

/** The immutable envelope that is hashed and sent. Mirrors fieldsync.models.EventIn. */
export interface Envelope {
  seq: number; op_id: string; type: string; schema_version: number; record_id: string;
  ts_ms: number; base_version: number | null; payload: Record<string, unknown>; content_hash: string;
}
export interface StoredEvent { seq: number; state: EventState; attempts: number; error?: string; env: Envelope }

export interface Store {
  /** Monotonic, persisted, never reused (survives compaction). */
  nextSeq(): Promise<number>;
  put(e: StoredEvent): Promise<void>;
  all(): Promise<StoredEvent[]>;
  patch(seq: number, p: Partial<Pick<StoredEvent, "state" | "attempts" | "error">>): Promise<void>;
  remove(seqs: number[]): Promise<void>;
}

export type SendResult =
  | { kind: "ok"; ack_through: number; accepted: number; duplicates: number; replay: boolean }
  | { kind: "gap"; expected_seq: number; ack_through: number }
  | { kind: "rejected"; seq: number; reason: string; ack_through: number; message: string }
  | { kind: "blocked"; blocked_seq: number | null; ack_through: number }
  | { kind: "network" }
  | { kind: "auth" };

export interface Transport {
  cursor(): Promise<{ acked_seq: number; sync_state: string; blocked_seq: number | null }>;
  send(key: string, events: Envelope[]): Promise<SendResult>;
}

export type SyncOutcome =
  | { status: "ok"; acked: number }
  | { status: "offline" | "auth"; acked: number }
  | { status: "blocked"; acked: number }
  | { status: "rejected"; acked: number; reason: string; seq: number };
