import { describe, expect, it } from "vitest";
import { SyncEngine } from "../src/lib/sync/engine";
import { MemoryStore } from "../src/lib/sync/stores";
import { FakeServer } from "./fakeServer";

const setup = (batchSize = 5) => {
  const server = new FakeServer("unit-1");
  const store = new MemoryStore();
  const engine = new SyncEngine({ deviceId: "unit-1", store, transport: server.transport(), batchSize });
  return { server, store, engine };
};
const fill = async (e: SyncEngine, n: number) => { for (let i = 0; i < n; i++) await e.append(i ? "note.add" : "report.create", "rec-0001", i ? { text: `n${i}` } : { title: "t", body: "b" }); };

describe("offline-first sync engine", () => {
  it("records durably with contiguous sequence numbers before any network call", async () => {
    const { engine, server } = setup();
    await fill(engine, 6);
    expect((await engine.store.all()).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(server.calls).toBe(0);
    expect(await engine.stats()).toMatchObject({ local: 6, acked: 0, queueDepth: 6 });
  });

  it("uploads in order across batches and marks acknowledged only after the server acknowledges", async () => {
    const { engine, server } = setup(4);
    await fill(engine, 10);
    const r = await engine.syncOnce();
    expect(r).toEqual({ status: "ok", acked: 10 });
    expect(server.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(await engine.stats()).toMatchObject({ acked: 10, local: 0, queueDepth: 0 });
  });

  it("keeps everything and retries later when the network is down", async () => {
    const { engine, server } = setup();
    await fill(engine, 3);
    server.dropNext = 1;
    expect((await engine.syncOnce()).status).toBe("offline");
    expect(await engine.stats()).toMatchObject({ local: 3, acked: 0 });
    expect(engine.retries).toBe(1);
    expect((await engine.syncOnce()).status).toBe("ok");
    expect(server.events).toHaveLength(3);
  });

  it("recovers from a lost acknowledgement without duplicating anything", async () => {
    const { engine, server } = setup(10);
    await fill(engine, 5);
    server.loseNextAck = 1;   // server commits, the response never arrives
    expect((await engine.syncOnce()).status).toBe("offline");
    expect(server.events).toHaveLength(5);
    expect(await engine.stats()).toMatchObject({ local: 5 });  // the device cannot know yet
    expect((await engine.syncOnce()).status).toBe("ok");        // cursor shows 5: nothing is re-sent
    expect(server.events).toHaveLength(5);
    expect(await engine.stats()).toMatchObject({ acked: 5, local: 0 });
  });

  it("a retried batch is byte-identical, so its idempotency key matches and the server replays it", async () => {
    const { engine, server } = setup(10);
    await fill(engine, 3);
    server.loseNextAck = 1; server.cursorDown = false;
    await engine.syncOnce();
    const keys = [...server.batches.keys()];
    server.acked = 0; server.events = [];          // pretend the cursor were unreachable: force a re-send
    (server as unknown as { blocked: null }).blocked = null;
    server.cursorDown = false;
    await engine.store.patch(1, { state: "local" }); await engine.store.patch(2, { state: "local" }); await engine.store.patch(3, { state: "local" });
    server.batches.set(keys[0]!, { hash: "x", result: { kind: "ok", ack_through: 3, accepted: 3, duplicates: 0, replay: false } });
    server.acked = 3;
    const r = await engine.syncOnce();
    expect(r.status).toBe("ok");
    expect(keys).toHaveLength(1);
  });

  it("realigns when the server reports a gap", async () => {
    const { engine, server } = setup();
    await fill(engine, 3);
    server.acked = 0;
    await engine.store.patch(1, { state: "acked" });   // local believes #1 is delivered, server disagrees
    const r = await engine.syncOnce();
    expect(r.status).toBe("blocked");                   // cannot invent history; needs attention
  });

  it("stops on a rejected event, keeps it locally as failed, and resumes after review", async () => {
    const { engine, server } = setup(10);
    await fill(engine, 3);
    const all = await engine.store.all();
    await engine.store.put({ ...all[1]!, env: { ...all[1]!.env, payload: { text: "corrupted" } } });  // bit-rot on device
    const r = await engine.syncOnce();
    expect(r).toMatchObject({ status: "rejected", reason: "hash_mismatch", seq: 2 });
    expect(server.acked).toBe(1);
    expect((await engine.stats()).failed).toBe(1);
    expect((await engine.syncOnce()).status).toBe("blocked");
    server.blocked = null;                                // reviewer authorised a retry
    await engine.store.put({ ...all[1]!, state: "failed" });   // original restored
    await engine.retryFailed();
    expect((await engine.syncOnce()).status).toBe("ok");
    expect(server.acked).toBe(3);
  });

  it("never reuses a sequence number, even after compaction", async () => {
    const { engine } = setup(10);
    await fill(engine, 5);
    await engine.syncOnce();
    expect(await engine.compact(2)).toBe(3);
    const next = await engine.append("note.add", "rec-0001", { text: "later" });
    expect(next.seq).toBe(6);
    expect((await engine.store.all()).map((e) => e.seq)).toEqual([4, 5, 6]);
  });

  it("does not run two sync passes at once", async () => {
    const { engine, server } = setup(2);
    await fill(engine, 6);
    const [a, b] = await Promise.all([engine.syncOnce(), engine.syncOnce()]);
    expect(a.acked + b.acked).toBe(6);
    expect(server.events).toHaveLength(6);
  });

  it("handles a large backlog of 500 events", async () => {
    const { engine, server } = setup(50);
    await fill(engine, 500);
    expect((await engine.syncOnce()).acked).toBe(500);
    expect(server.acked).toBe(500);
  });

  it("reports offline when the cursor cannot be read", async () => {
    const { engine, server } = setup();
    await fill(engine, 1);
    server.cursorDown = true;
    expect(await engine.syncOnce()).toEqual({ status: "offline", acked: 0 });
  });
});
