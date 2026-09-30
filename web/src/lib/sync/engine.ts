import { canonicalJson } from "../canonical";
import { sha256Hex } from "../crypto";
import type { Envelope, Store, StoredEvent, SyncOutcome, Transport } from "./types";

const enc = (s: string) => new TextEncoder().encode(s) as Uint8Array<ArrayBuffer>;

/** Hash of the event envelope (everything but the hash). Byte-identical to the Python service. */
export async function eventHash(deviceId: string, e: Omit<Envelope, "content_hash"> | Envelope): Promise<string> {
  const { content_hash: _drop, ...rest } = e as Envelope;
  void _drop;
  return sha256Hex(enc(canonicalJson({ ...rest, device_id: deviceId })));
}

/** Full-jitter exponential backoff, capped. `rand` is injectable for tests. */
export function backoffMs(attempt: number, rand: () => number = Math.random, base = 1000, cap = 60_000): number {
  return Math.max(250, Math.floor(rand() * Math.min(cap, base * 2 ** Math.max(0, attempt))));
}

export interface Stats { local: number; uploading: number; acked: number; failed: number; queueDepth: number; oldestPendingAgeS: number }

export class SyncEngine {
  private busy = false;
  retries = 0;
  duplicates = 0;

  constructor(private readonly d: { deviceId: string; store: Store; transport: Transport; now?: () => number; batchSize?: number }) {}

  get store(): Store { return this.d.store; }

  private now() { return this.d.now?.() ?? Date.now(); }

  async append(type: string, recordId: string, payload: Record<string, unknown>, opts: { baseVersion?: number | null; schemaVersion?: number } = {}): Promise<StoredEvent> {
    const seq = await this.d.store.nextSeq();
    const body = {
      seq, op_id: crypto.randomUUID().replaceAll("-", ""), type, schema_version: opts.schemaVersion ?? 1, record_id: recordId,
      ts_ms: this.now(), base_version: opts.baseVersion ?? null, payload,
    };
    const env: Envelope = { ...body, content_hash: await eventHash(this.d.deviceId, body) };
    const ev: StoredEvent = { seq, state: "local", attempts: 0, env };
    await this.d.store.put(ev);  // durable before the UI is told it succeeded
    return ev;
  }

  async stats(): Promise<Stats> {
    const all = await this.d.store.all();
    const c = { local: 0, uploading: 0, acked: 0, failed: 0 };
    for (const e of all) c[e.state]++;
    const pending = all.filter((e) => e.state === "local" || e.state === "uploading");
    const oldest = pending[0]?.env.ts_ms;
    return { ...c, queueDepth: pending.length + c.failed, oldestPendingAgeS: oldest ? Math.max(0, Math.round((this.now() - oldest) / 1000)) : 0 };
  }

  private async markThrough(seq: number, state: "acked" | "local" | "uploading") {
    for (const e of await this.d.store.all()) if (e.seq <= seq && e.state !== "acked" && e.state !== "failed") await this.d.store.patch(e.seq, { state });
  }

  /** One resumable pass: read the server cursor, then upload contiguous batches until drained. */
  async syncOnce(): Promise<SyncOutcome> {
    if (this.busy) return { status: "ok", acked: 0 };
    this.busy = true;
    let total = 0;
    try {
      let cur;
      try { cur = await this.d.transport.cursor(); } catch { return { status: "offline", acked: 0 }; }
      await this.markThrough(cur.acked_seq, "acked");  // recovers from lost acknowledgements
      if (cur.sync_state === "blocked") return { status: "blocked", acked: 0 };
      for (let guard = 0; guard < 1000; guard++) {
        const pending = (await this.d.store.all()).filter((e) => e.state === "local" || e.state === "uploading").slice(0, this.d.batchSize ?? 50);
        if (!pending.length) return { status: "ok", acked: total };
        const evs = pending.map((p) => p.env);
        const first = evs[0]!.seq, last = evs[evs.length - 1]!.seq;
        const key = `${this.d.deviceId}:${first}-${last}:${(await sha256Hex(enc(canonicalJson(evs)))).slice(0, 16)}`;
        for (const p of pending) await this.d.store.patch(p.seq, { state: "uploading", attempts: p.attempts + 1 });
        const r = await this.d.transport.send(key, evs);
        switch (r.kind) {
          case "ok":
            total += r.accepted; this.duplicates += r.duplicates;
            await this.markThrough(r.ack_through, "acked");
            continue;
          case "gap":
            await this.markThrough(last, "local");
            // Server needs an event this device no longer holds: never invent history, stop and surface it.
            if (r.expected_seq < first) return { status: "blocked", acked: total };
            await this.markThrough(r.ack_through, "acked");  // server is ahead of us: adopt its cursor
            continue;
          case "rejected":
            await this.markThrough(last, "local");
            await this.markThrough(r.ack_through, "acked");
            await this.d.store.patch(r.seq, { state: "failed", error: r.reason });
            return { status: "rejected", acked: total, reason: r.reason, seq: r.seq };
          case "blocked":
            await this.markThrough(last, "local");
            return { status: "blocked", acked: total };
          case "auth":
            await this.markThrough(last, "local");
            return { status: "auth", acked: total };
          case "network":
            this.retries++;
            await this.markThrough(last, "local");
            return { status: "offline", acked: total };
        }
      }
      return { status: "ok", acked: total };
    } finally {
      this.busy = false;
    }
  }

  /** Re-queue events a reviewer has authorised for retry. */
  async retryFailed(): Promise<void> {
    for (const e of await this.d.store.all()) if (e.state === "failed") await this.d.store.patch(e.seq, { state: "local", error: undefined });
  }

  /** The only deletion ever performed: acknowledged events beyond the newest `keep`. */
  async compact(keep = 20): Promise<number> {
    const acked = (await this.d.store.all()).filter((e) => e.state === "acked");
    const drop = acked.slice(0, Math.max(0, acked.length - keep)).map((e) => e.seq);
    await this.d.store.remove(drop);
    return drop.length;
  }
}
