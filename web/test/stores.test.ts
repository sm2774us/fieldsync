import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { SyncEngine } from "../src/lib/sync/engine";
import { IdbStore, aesCipher, passthroughCipher } from "../src/lib/sync/stores";
import { FakeServer } from "./fakeServer";

describe("IndexedDB store", () => {
  it("survives closing and reopening (device restart) and keeps delivery state", async () => {
    const name = `t-${Math.random()}`;
    const a = await IdbStore.open(name, passthroughCipher);
    const eng = new SyncEngine({ deviceId: "unit-1", store: a, transport: new FakeServer("unit-1").transport() });
    await eng.append("note.add", "rec-0001", { text: "written offline" });
    const b = await IdbStore.open(name, passthroughCipher);
    const rows = await b.all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ seq: 1, state: "local", env: { payload: { text: "written offline" } } });
    await b.patch(1, { state: "acked" });
    expect((await (await IdbStore.open(name, passthroughCipher)).all())[0]!.state).toBe("acked");
  });

  it("sequence counter is persistent and monotonic across removals", async () => {
    const s = await IdbStore.open(`t-${Math.random()}`, passthroughCipher);
    expect([await s.nextSeq(), await s.nextSeq()]).toEqual([1, 2]);
    await s.remove([1, 2]);
    expect(await s.nextSeq()).toBe(3);
  });

  it("syncs from a reopened store", async () => {
    const name = `t-${Math.random()}`;
    const server = new FakeServer("unit-1");
    const e1 = new SyncEngine({ deviceId: "unit-1", store: await IdbStore.open(name, passthroughCipher), transport: server.transport() });
    await e1.append("report.create", "rec-0001", { title: "t", body: "b" });
    const e2 = new SyncEngine({ deviceId: "unit-1", store: await IdbStore.open(name, passthroughCipher), transport: server.transport() });
    expect((await e2.syncOnce()).acked).toBe(1);
  });
});

describe("encryption at rest", () => {
  it("AES-GCM round-trips, uses a fresh IV, and hides the plaintext", async () => {
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const c = aesCipher(key, "unit-1");
    const pt = new TextEncoder().encode("TOP-SECRET-PLAINTEXT") as Uint8Array<ArrayBuffer>;
    const a = await c.encrypt(pt), b = await c.encrypt(pt);
    expect(new TextDecoder().decode(a)).not.toContain("TOP-SECRET");
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
    expect(new TextDecoder().decode(await c.decrypt(a))).toBe("TOP-SECRET-PLAINTEXT");
  });
  it("detects tampering and binds ciphertext to the device id", async () => {
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const ct = await aesCipher(key, "unit-1").encrypt(new TextEncoder().encode("x") as Uint8Array<ArrayBuffer>);
    const flipped = new Uint8Array(ct); flipped[flipped.length - 1]! ^= 1;
    await expect(aesCipher(key, "unit-1").decrypt(flipped)).rejects.toThrow();
    await expect(aesCipher(key, "unit-2").decrypt(ct)).rejects.toThrow();
  });
  it("encrypted store never contains the payload in stored rows", async () => {
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const name = `t-${Math.random()}`;
    const s = await IdbStore.open(name, aesCipher(key, "unit-1"));
    await new SyncEngine({ deviceId: "unit-1", store: s, transport: new FakeServer("unit-1").transport() }).append("note.add", "rec-0001", { text: "PLAINTEXT-MARKER" });
    const raw = await new Promise<unknown[]>((ok) => { const r = indexedDB.open(name); r.onsuccess = () => { const g = r.result.transaction("events").objectStore("events").getAll(); g.onsuccess = () => ok(g.result); }; });
    expect(JSON.stringify(raw)).not.toContain("PLAINTEXT-MARKER");
    expect((await s.all())[0]!.env.payload).toEqual({ text: "PLAINTEXT-MARKER" });
  });
});
