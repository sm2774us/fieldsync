import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileLog, MemoryLog, SyncClient, canonicalJson, eventHash, type Envelope } from "../src/client.ts";

const vector = JSON.parse(readFileSync(new URL("../../tests/vectors/event_vector.json", import.meta.url), "utf8"));

/** Miniature of the service's ingest rules, driven through fetch. */
class FakeServer {
  acked = 0; blocked = false; events: Envelope[] = []; loseAck = 0; fail5xx = 0; batches = new Map<string, unknown>();
  fetch: typeof fetch = async (url, init) => {
    const u = String(url);
    if (this.fail5xx > 0) { this.fail5xx--; return new Response("", { status: 503 }); }
    if (u.endsWith("/cursor")) return Response.json({ acked_seq: this.acked, sync_state: this.blocked ? "blocked" : "ok" });
    const { events, device_id } = JSON.parse(String(init?.body)) as { events: Envelope[]; device_id: string };
    const key = (init?.headers as Record<string, string>)["idempotency-key"]!;
    if (this.batches.has(key)) return Response.json(this.batches.get(key));
    let accepted = 0, duplicates = 0;
    for (const e of events) {
      if (e.seq <= this.acked) { duplicates++; continue; }
      if (e.seq !== this.acked + 1) return Response.json({ error: "sequence_gap", expected_seq: this.acked + 1, ack_through: this.acked }, { status: 409 });
      if (eventHash(device_id, e) !== e.content_hash) { this.blocked = true; return Response.json({ error: "integrity_failure", reason: "hash_mismatch", seq: e.seq, ack_through: this.acked }, { status: 422 }); }
      this.events.push(e); this.acked = e.seq; accepted++;
    }
    const body = { accepted, duplicates, ack_through: this.acked };
    this.batches.set(key, body);
    if (this.loseAck > 0) { this.loseAck--; throw new TypeError("response lost"); }
    return Response.json(body);
  };
}
const make = (over: Partial<ConstructorParameters<typeof SyncClient>[0]> = {}) => {
  const server = new FakeServer(); const store = new MemoryLog();
  const client = new SyncClient({ baseUrl: "http://x", token: "t", deviceId: "unit-1", store, fetchImpl: server.fetch, sleep: async () => {}, batchSize: 4, maxRetries: 2, ...over });
  return { server, store, client };
};
const fill = (c: SyncClient, n: number) => { for (let i = 0; i < n; i++) c.append(i ? "note.add" : "report.create", "rec-0001", i ? { text: `n${i}` } : { title: "t", body: "b" }); };

test("event hash matches the Python service byte-for-byte (non-ASCII, null base_version)", () => {
  assert.equal(eventHash(vector.device_id, vector.event), vector.event.content_hash);
  assert.notEqual(eventHash("unit-2", vector.event), vector.event.content_hash);
  assert.equal(canonicalJson({ b: "é✓", a: 1 }), '{"a":1,"b":"\\u00e9\\u2713"}');
});

test("records durably with contiguous sequence numbers and uploads in order", async () => {
  const { client, server, store } = make();
  fill(client, 10);
  assert.deepEqual(store.all().map((e) => e.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(await client.syncOnce(), { status: "ok", acked: 10 });
  assert.deepEqual(server.events.map((e) => e.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.ok(store.all().every((e) => e.state === "acked"));
});

test("retries 5xx with backoff and gives up as offline without losing anything", async () => {
  const { client, server, store } = make(); fill(client, 3);
  server.fail5xx = 100;
  assert.equal((await client.syncOnce()).status, "offline");
  assert.equal(store.all().length, 3);
  server.fail5xx = 0;
  assert.equal((await client.syncOnce()).status, "ok");
});

test("a lost acknowledgement is absorbed by the idempotent retry (same key, stored result replayed)", async () => {
  const { client, server, store } = make({ batchSize: 10 }); fill(client, 5);
  server.loseAck = 1;
  assert.equal((await client.syncOnce()).status, "ok");
  assert.equal(server.events.length, 5);
  assert.equal(server.batches.size, 1);
  assert.ok(store.all().every((e) => e.state === "acked"));
});

test("if the link stays down after the commit, the next pass reads the cursor and resends nothing", async () => {
  const { client, server, store } = make({ batchSize: 10, maxRetries: 0 }); fill(client, 5);
  server.loseAck = 1;
  assert.equal((await client.syncOnce()).status, "offline");
  assert.equal(server.events.length, 5);
  assert.ok(store.all().every((e) => e.state === "local"));  // the device cannot know yet
  assert.equal((await client.syncOnce()).status, "ok");
  assert.equal(server.events.length, 5);
  assert.equal(server.batches.size, 1);
  assert.ok(store.all().every((e) => e.state === "acked"));
});

test("a corrupted event is rejected, kept as failed, and the device pauses until review", async () => {
  const { client, server, store } = make({ batchSize: 10 }); fill(client, 3);
  const two = store.all()[1]!; store.put({ ...two, env: { ...two.env, payload: { text: "bitrot" } } });
  const r = await client.syncOnce();
  assert.deepEqual(r, { status: "rejected", acked: 0, reason: "hash_mismatch", seq: 2 });
  assert.equal(server.acked, 1);
  assert.equal(store.all()[1]!.state, "failed");
  assert.equal((await client.syncOnce()).status, "blocked");
  server.blocked = false; store.put({ ...two, state: "failed" }); client.retryFailed();
  assert.equal((await client.syncOnce()).status, "ok");
  assert.equal(server.acked, 3);
});

test("never invents history when the server needs an event the device no longer holds", async () => {
  const { client, server } = make({ batchSize: 10 }); fill(client, 3);
  server.acked = 0;
  await client.syncOnce();  // uploads 1..3
  assert.equal(server.acked, 3);
  server.acked = 0; server.events = []; server.batches.clear();
  client.compact(0);
  client.append("note.add", "rec-0001", { text: "after compaction" });
  assert.equal((await client.syncOnce()).status, "blocked");
});

test("sequence numbers are never reused after compaction", async () => {
  const { client } = make({ batchSize: 10 }); fill(client, 5);
  await client.syncOnce();
  assert.equal(client.compact(2), 3);
  assert.equal(client.append("note.add", "rec-0001", { text: "x" }).seq, 6);
});

test("file log is encrypted at rest, survives restart, and rejects a wrong key or device", () => {
  const dir = mkdtempSync(join(tmpdir(), "fs-")); const path = join(dir, "log.bin"); const key = randomBytes(32);
  const a = new SyncClient({ baseUrl: "http://x", token: "t", deviceId: "unit-1", store: new FileLog(path, key, "unit-1") });
  a.append("note.add", "rec-0001", { text: "TOP-SECRET-PLAINTEXT" });
  assert.ok(!readFileSync(path).includes("TOP-SECRET-PLAINTEXT"));
  const reopened = new FileLog(path, key, "unit-1");
  assert.equal(reopened.all()[0]!.env.payload.text, "TOP-SECRET-PLAINTEXT");
  assert.equal(reopened.nextSeq(), 2);
  assert.throws(() => new FileLog(path, randomBytes(32), "unit-1"));
  assert.throws(() => new FileLog(path, key, "unit-2"));
});
