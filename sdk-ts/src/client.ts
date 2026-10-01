import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

/** Deterministic JSON identical to the Python service (sorted keys, no whitespace, ASCII-only). */
export function canonicalJson(v: unknown): string {
  const walk = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object") {
      return Object.fromEntries(
        Object.entries(x as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, val]) => [k, walk(val)]),
      );
    }
    return x;
  };
  return JSON.stringify(walk(v)).replace(/[\u0080-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

const sha256 = (s: string | Uint8Array): string => createHash("sha256").update(s).digest("hex");

export interface Envelope {
  seq: number; op_id: string; type: string; schema_version: number; record_id: string;
  ts_ms: number; base_version: number | null; payload: Record<string, unknown>; content_hash: string;
}
export type EventState = "local" | "uploading" | "acked" | "failed";
export interface StoredEvent { seq: number; state: EventState; env: Envelope; error?: string }

/** SHA-256 over the canonical envelope (without the hash) plus the device id. */
export function eventHash(deviceId: string, e: Omit<Envelope, "content_hash"> | Envelope): string {
  const { content_hash: _ignored, ...rest } = e as Envelope;
  void _ignored;
  return sha256(canonicalJson({ ...rest, device_id: deviceId }));
}

export interface LogStore {
  nextSeq(): number;
  put(e: StoredEvent): void;
  all(): StoredEvent[];
  setState(seq: number, state: EventState, error?: string): void;
  remove(seqs: number[]): void;
}

export class MemoryLog implements LogStore {
  protected rows = new Map<number, StoredEvent>();
  protected seq = 0;
  nextSeq() { return ++this.seq; }
  put(e: StoredEvent) { this.rows.set(e.seq, structuredClone(e)); }
  all() { return [...this.rows.values()].sort((a, b) => a.seq - b.seq).map((e) => structuredClone(e)); }
  setState(seq: number, state: EventState, error?: string) { const r = this.rows.get(seq); if (r) this.rows.set(seq, { ...r, state, error }); }
  remove(seqs: number[]) { for (const s of seqs) this.rows.delete(s); }
}

/** Encrypted-at-rest log (AES-256-GCM, device id as AAD). Snapshot written atomically (tmp + rename);
 *  the sequence counter is persisted separately from the rows so compaction can never rewind it. */
export class FileLog extends MemoryLog {
  private readonly path: string;
  private readonly key: Buffer;
  private readonly deviceId: string;
  constructor(path: string, key: Buffer, deviceId: string) {
    super();
    this.path = path; this.key = key; this.deviceId = deviceId;
    if (existsSync(path)) {
      const raw = readFileSync(path);
      const d = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
      d.setAAD(Buffer.from(deviceId)); d.setAuthTag(raw.subarray(12, 28));
      const snap = JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString()) as { seq: number; rows: StoredEvent[] };
      this.seq = snap.seq;
      for (const r of snap.rows) this.rows.set(r.seq, r);
    }
  }
  private persist() {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    c.setAAD(Buffer.from(this.deviceId));
    const ct = Buffer.concat([c.update(JSON.stringify({ seq: this.seq, rows: this.all() })), c.final()]);
    writeFileSync(this.path + ".tmp", Buffer.concat([iv, c.getAuthTag(), ct]));
    renameSync(this.path + ".tmp", this.path);
  }
  override nextSeq() { const n = super.nextSeq(); this.persist(); return n; }
  override put(e: StoredEvent) { super.put(e); this.persist(); }
  override setState(seq: number, state: EventState, error?: string) { super.setState(seq, state, error); this.persist(); }
  override remove(seqs: number[]) { super.remove(seqs); this.persist(); }
}

export type SyncOutcome =
  | { status: "ok"; acked: number }
  | { status: "offline" | "auth" | "blocked"; acked: number }
  | { status: "rejected"; acked: number; reason: string; seq: number };

export interface ClientOptions {
  baseUrl: string; token: string; deviceId: string; store: LogStore;
  batchSize?: number; maxRetries?: number;
  sleep?: (ms: number) => Promise<void>; fetchImpl?: typeof fetch; now?: () => number;
}

export class SyncClient {
  private readonly o: ClientOptions;
  duplicates = 0;
  retries = 0;
  constructor(options: ClientOptions) { this.o = options; }

  /** Durable before returning: the caller may tell the operator "saved". */
  append(type: string, recordId: string, payload: Record<string, unknown>, opts: { baseVersion?: number | null; schemaVersion?: number } = {}): StoredEvent {
    const seq = this.o.store.nextSeq();
    const body = { seq, op_id: randomUUID().replaceAll("-", ""), type, schema_version: opts.schemaVersion ?? 1, record_id: recordId,
      ts_ms: this.o.now?.() ?? Date.now(), base_version: opts.baseVersion ?? null, payload };
    const ev: StoredEvent = { seq, state: "local", env: { ...body, content_hash: eventHash(this.o.deviceId, body) } };
    this.o.store.put(ev);
    return ev;
  }

  private async call(method: string, path: string, init: RequestInit = {}): Promise<Response | undefined> {
    const f = this.o.fetchImpl ?? fetch;
    const max = this.o.maxRetries ?? 3;
    const sleep = this.o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await f(this.o.baseUrl + path, { ...init, method, headers: { authorization: `Bearer ${this.o.token}`, "content-type": "application/json", ...(init.headers as Record<string, string>) } });
        if (res.status < 500) return res;
      } catch { /* network failure: retry */ }
      this.retries++;
      if (attempt >= max) return undefined;
      await sleep(Math.min(30_000, 250 * 2 ** attempt) * (0.5 + Math.random() / 2));
    }
  }

  private mark(through: number, from: EventState[], to: EventState) {
    for (const e of this.o.store.all()) if (e.seq <= through && from.includes(e.state)) this.o.store.setState(e.seq, to);
  }

  /** One resumable pass: read the server cursor, then upload contiguous batches until drained. */
  async syncOnce(): Promise<SyncOutcome> {
    const cur = await this.call("GET", `/v1/devices/${encodeURIComponent(this.o.deviceId)}/cursor`);
    if (!cur) return { status: "offline", acked: 0 };
    if (cur.status === 401) return { status: "auth", acked: 0 };
    const c = (await cur.json()) as { acked_seq: number; sync_state: string };
    this.mark(c.acked_seq, ["local", "uploading"], "acked");  // recovers from lost acknowledgements
    if (c.sync_state === "blocked") return { status: "blocked", acked: 0 };
    let total = 0;
    for (;;) {
      const pending = this.o.store.all().filter((e) => e.state === "local" || e.state === "uploading").slice(0, this.o.batchSize ?? 50);
      if (!pending.length) return { status: "ok", acked: total };
      const evs = pending.map((p) => p.env);
      const first = evs[0]!.seq, last = evs[evs.length - 1]!.seq;
      const key = `${this.o.deviceId}:${first}-${last}:${sha256(canonicalJson(evs)).slice(0, 16)}`;
      for (const p of pending) this.o.store.setState(p.seq, "uploading");
      const res = await this.call("POST", "/v1/sync/batches", { body: JSON.stringify({ device_id: this.o.deviceId, events: evs }), headers: { "idempotency-key": key } });
      const back = (n: number) => this.mark(n, ["uploading"], "local");
      if (!res) { back(last); return { status: "offline", acked: total }; }
      const b = (await res.json()) as Record<string, number | string>;
      if (res.status === 200) {
        total += Number(b.accepted); this.duplicates += Number(b.duplicates);
        this.mark(Number(b.ack_through), ["local", "uploading"], "acked");
        continue;
      }
      back(last);
      if (res.status === 401) return { status: "auth", acked: total };
      if (res.status === 422 && typeof b.seq === "number") {
        this.mark(Number(b.ack_through ?? 0), ["local", "uploading"], "acked");
        this.o.store.setState(b.seq, "failed", String(b.reason ?? b.error));
        return { status: "rejected", acked: total, reason: String(b.reason ?? b.error), seq: b.seq };
      }
      if (res.status === 409 && b.error === "sequence_gap") {
        if (Number(b.expected_seq) < first) return { status: "blocked", acked: total };  // never invent history
        this.mark(Number(b.ack_through), ["local", "uploading"], "acked");
        continue;
      }
      return { status: res.status === 409 ? "blocked" : "offline", acked: total };
    }
  }

  /** Re-queue events a reviewer has authorised for retry. */
  retryFailed() { for (const e of this.o.store.all()) if (e.state === "failed") this.o.store.setState(e.seq, "local"); }

  /** The only deletion ever performed: acknowledged events beyond the newest `keep`. */
  compact(keep = 20): number {
    const acked = this.o.store.all().filter((e) => e.state === "acked");
    const drop = acked.slice(0, Math.max(0, acked.length - keep)).map((e) => e.seq);
    this.o.store.remove(drop);
    return drop.length;
  }
}
