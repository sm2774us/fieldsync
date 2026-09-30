import { useSession } from "@/store/session";
import type {
  Alert, AuditEntry, ChainStatus, Conflict, Device, Ready, RecordDetail, RecordSummary, ServerEvent,
  QuarantineItem, ServiceKey,
} from "./types";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;
  readonly extra: Record<string, unknown>;
  constructor(status: number, code: string, message: string, requestId?: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.extra = extra;
  }
  /** Network failure or 5xx: worth retrying. 4xx are deterministic and are not. */
  get retryable(): boolean { return this.status === 0 || this.status >= 500; }
}

interface Opts {
  method?: string;
  body?: BodyInit | null;
  json?: unknown;
  headers?: Record<string, string>;
  query?: Record<string, string | number | undefined>;
  timeoutMs?: number;
  auth?: boolean;
}

async function send(path: string, o: Opts = {}): Promise<Response> {
  const url = new URL(path, window.location.origin);
  for (const [k, v] of Object.entries(o.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
  const headers: Record<string, string> = { ...o.headers };
  const token = useSession.getState().token;
  if (o.auth !== false && token) headers.authorization = `Bearer ${token}`;
  let body = o.body ?? null;
  if (o.json !== undefined) { body = JSON.stringify(o.json); headers["content-type"] = "application/json"; }

  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, o.timeoutMs ?? 15_000);
  let res: Response;
  try {
    res = await fetch(url, { method: o.method ?? "GET", headers, body, signal: ctl.signal, cache: "no-store", credentials: "omit" });
  } catch {
    throw new ApiError(0, timedOut ? "timeout" : "network",
      timedOut ? "The service did not respond in time." : "Cannot reach the service. Check your connection.");
  } finally {
    clearTimeout(timer);
  }
  if (res.ok) return res;

  const requestId = res.headers.get("x-request-id") ?? undefined;
  let payload: Record<string, unknown> = {};
  try { payload = (await res.json()) as Record<string, unknown>; } catch { /* non-JSON error body */ }
  const { error, message, detail, ...extra } = payload;
  if (res.status === 401 && o.auth !== false) useSession.getState().signOut("Your session is no longer valid. Sign in again.");
  const msg = typeof message === "string" ? message
    : Array.isArray(detail) ? "The request was malformed." : res.statusText || "Request failed";
  throw new ApiError(res.status, typeof error === "string" ? error : `http_${res.status}`, msg, requestId, extra);
}

const json = async <T>(path: string, o?: Opts): Promise<T> => (await send(path, o)).json() as Promise<T>;
const post = <T>(path: string, o: Opts = {}) => json<T>(path, { ...o, method: "POST" });
const enc = encodeURIComponent;

export type SendResult =
  | { kind: "ok"; ack_through: number; accepted: number; duplicates: number; replay: boolean }
  | { kind: "gap"; expected_seq: number; ack_through: number }
  | { kind: "rejected"; seq: number; reason: string; ack_through: number; message: string }
  | { kind: "blocked"; blocked_seq: number | null; ack_through: number }
  | { kind: "network" }
  | { kind: "auth" };

export const api = {
  /** /readyz answers 503 with JSON when the audit chain is broken: surface it, never hide it. */
  ready: (): Promise<Ready> =>
    json<Ready>("/readyz", { auth: false, timeoutMs: 6000 }).catch((e: unknown) => {
      if (e instanceof ApiError && e.status === 503) {
        return { ready: false, audit_entries: Number(e.extra.audit_entries ?? 0), audit_error: String(e.extra.audit_error ?? "audit chain failed verification") };
      }
      throw e;
    }),
  metricsText: async () => (await send("/metrics", { auth: false, timeoutMs: 6000 })).text(),
  keys: () => json<ServiceKey>("/v1/keys", { auth: false }),

  fleet: () => json<{ devices: Device[] }>("/v1/fleet").then((r) => r.devices),
  device: (id: string) => json<Device>(`/v1/devices/${enc(id)}`),
  deviceEvents: (id: string, after = 0, limit = 200) => json<{ events: ServerEvent[] }>(`/v1/devices/${enc(id)}/events`, { query: { after, limit } }).then((r) => r.events),
  scanFleet: () => post<{ alerts: string[] }>("/v1/fleet/scan"),
  registerDevice: (b: { device_id: string; label: string; agency_id: string }) => post<{ device_id: string; status: string }>("/v1/devices", { json: b }),
  activateDevice: (id: string) => post<{ device_id: string; status: string }>(`/v1/devices/${enc(id)}/activate`),
  revokeDevice: (id: string, reason: string) => post<{ device_id: string; status: string }>(`/v1/devices/${enc(id)}/revoke`, { query: { reason } }),

  records: () => json<{ records: RecordSummary[] }>("/v1/records").then((r) => r.records),
  record: (id: string) => json<RecordDetail>(`/v1/records/${enc(id)}`),
  conflicts: (status: "open" | "resolved") => json<{ conflicts: Conflict[] }>("/v1/conflicts", { query: { status } }).then((r) => r.conflicts),
  resolveConflict: (id: string, decision: "apply_proposed" | "keep_current", note: string) =>
    post<{ conflict_id: string; new_version: number | null }>(`/v1/conflicts/${enc(id)}/resolve`, { json: { decision, note } }),
  quarantine: (status: "open" | "retry_authorized" | "skip_authorized") => json<{ items: QuarantineItem[] }>("/v1/quarantine", { query: { status } }).then((r) => r.items),
  disposition: (id: string, decision: "retry_authorized" | "skip_authorized", note: string) =>
    post<{ quarantine_id: string; decision: string }>(`/v1/quarantine/${enc(id)}/disposition`, { json: { decision, note } }),

  alerts: (status: "open" | "acknowledged") => json<{ alerts: Alert[] }>("/v1/alerts", { query: { status } }).then((r) => r.alerts),
  ackAlert: (id: string) => post<{ alert_id: string; status: string }>(`/v1/alerts/${enc(id)}/ack`),
  audit: (after = 0, limit = 200) => json<{ entries: AuditEntry[] }>("/v1/audit", { query: { after, limit } }).then((r) => r.entries),
  auditVerify: () => post<ChainStatus>("/v1/audit/verify"),
  auditCheckpoint: () => post<Record<string, unknown>>("/v1/audit/checkpoint"),

  // ---- device (field) side: used by the offline-first sync engine ------------------------
  cursor: (id: string) => json<{ acked_seq: number; sync_state: string; blocked_seq: number | null }>(`/v1/devices/${enc(id)}/cursor`, { timeoutMs: 8000 }),
  heartbeat: (id: string, hb: Record<string, unknown>) => post<{ ok: boolean }>(`/v1/devices/${enc(id)}/heartbeat`, { json: hb, timeoutMs: 8000 }),
  /** Never throws: every outcome the engine must distinguish is a value. */
  sendBatch: async (deviceId: string, key: string, events: unknown[]): Promise<SendResult> => {
    try {
      const r = await post<{ ack_through: number; accepted: number; duplicates: number; idempotent_replay: boolean }>("/v1/sync/batches",
        { json: { device_id: deviceId, events }, headers: { "idempotency-key": key }, timeoutMs: 20_000 });
      return { kind: "ok", ack_through: r.ack_through, accepted: r.accepted, duplicates: r.duplicates, replay: r.idempotent_replay };
    } catch (e) {
      if (!(e instanceof ApiError)) return { kind: "network" };
      const x = e.extra;
      if (e.status === 0 || e.status >= 500) return { kind: "network" };
      if (e.status === 401) return { kind: "auth" };
      if (e.code === "sequence_gap") return { kind: "gap", expected_seq: Number(x.expected_seq), ack_through: Number(x.ack_through) };
      if (e.status === 422 && typeof x.seq === "number") return { kind: "rejected", seq: x.seq, reason: String(x.reason ?? e.code), ack_through: Number(x.ack_through ?? 0), message: e.message };
      if (e.status === 409) return { kind: "blocked", blocked_seq: typeof x.blocked_seq === "number" ? x.blocked_seq : null, ack_through: Number(x.ack_through ?? 0) };
      throw e;
    }
  },
};
