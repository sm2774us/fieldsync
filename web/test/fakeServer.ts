import { eventHash } from "../src/lib/sync/engine";
import type { Envelope, SendResult, Transport } from "../src/lib/sync/types";

/** A faithful miniature of the service's ingest rules, for testing the client engine in isolation. */
export class FakeServer {
  acked = 0;
  events: Envelope[] = [];
  blocked: number | null = null;
  batches = new Map<string, { hash: string; result: SendResult }>();
  loseNextAck = 0;   // commit but report a network failure
  dropNext = 0;      // fail before commit
  cursorDown = false;
  calls = 0;

  constructor(private deviceId: string) {}

  transport(): Transport {
    return {
      cursor: async () => { if (this.cursorDown) throw new Error("down"); return { acked_seq: this.acked, sync_state: this.blocked ? "blocked" : "ok", blocked_seq: this.blocked }; },
      send: async (key, evs) => {
        this.calls++;
        if (this.dropNext > 0) { this.dropNext--; return { kind: "network" }; }
        const r = await this.ingest(key, evs);
        if (this.loseNextAck > 0) { this.loseNextAck--; return { kind: "network" }; }
        return r;
      },
    };
  }

  private async ingest(key: string, evs: Envelope[]): Promise<SendResult> {
    const hash = JSON.stringify(evs.map((e) => e.content_hash));
    const prior = this.batches.get(key);
    if (prior) return prior.result.kind === "ok" ? { ...prior.result, replay: true } : prior.result;
    if (this.blocked) return { kind: "blocked", blocked_seq: this.blocked, ack_through: this.acked };
    let accepted = 0, dups = 0;
    for (const e of evs) {
      if (e.seq <= this.acked) { dups++; continue; }
      if (e.seq !== this.acked + 1) return { kind: "gap", expected_seq: this.acked + 1, ack_through: this.acked };
      if ((await eventHash(this.deviceId, e)) !== e.content_hash) { this.blocked = e.seq; return { kind: "rejected", seq: e.seq, reason: "hash_mismatch", ack_through: this.acked, message: "mismatch" }; }
      this.events.push(e); this.acked = e.seq; accepted++;
    }
    const result: SendResult = { kind: "ok", ack_through: this.acked, accepted, duplicates: dups, replay: false };
    this.batches.set(key, { hash, result });
    return result;
  }
}
