import { describe, expect, it } from "vitest";
import vector from "./fixtures/event_vector.json";
import { PERMISSIONS, can, decodeToken, secondsLeft } from "../src/lib/auth";
import { canonicalJson } from "../src/lib/canonical";
import { fromHex, sha256Hex } from "../src/lib/crypto";
import { parseMetrics } from "../src/lib/metrics";
import { backoffMs, eventHash } from "../src/lib/sync/engine";
import { fmtBytes, fmtCountdown, relTime, shortHash } from "../src/lib/utils";
import { makeToken } from "./helpers";

describe("cross-language contract with the Python service", () => {
  it("computes the same event content hash as the server (including non-ASCII and null)", async () => {
    expect(await eventHash(vector.device_id, vector.event)).toBe(vector.event.content_hash);
  });
  it("any change to the event changes the hash", async () => {
    const tampered = { ...vector.event, payload: { ...vector.event.payload, body: "Line one." } };
    expect(await eventHash(vector.device_id, tampered)).not.toBe(vector.event.content_hash);
    expect(await eventHash("unit-2", vector.event)).not.toBe(vector.event.content_hash);
  });
  it("escapes non-ASCII like Python ensure_ascii and sorts keys", () => {
    expect(canonicalJson({ b: "é✓", a: 1 })).toBe('{"a":1,"b":"\\u00e9\\u2713"}');
  });
  it("hashes like SHA-256", async () => {
    expect(await sha256Hex(fromHex("616263"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("backoff", () => {
  it("grows exponentially, is jittered, capped and never zero", () => {
    expect(backoffMs(0, () => 1)).toBe(1000);
    expect(backoffMs(3, () => 1)).toBe(8000);
    expect(backoffMs(20, () => 1)).toBe(60_000);
    expect(backoffMs(5, () => 0)).toBe(250);
    expect(backoffMs(4, () => 0.5)).toBe(8000);
  });
});

describe("auth", () => {
  it("decodes a valid token and rejects garbage", () => {
    expect(decodeToken(makeToken())?.role).toBe("auditor");
    for (const bad of ["", "abc", "!!!.x", makeToken({ role: "root" }), `${btoa("{}")}.x`]) expect(decodeToken(bad)).toBeNull();
  });
  it("mirrors least privilege and separation of duties", () => {
    expect(can("admin", "events:read")).toBe(false);
    expect(can("admin", "records:read")).toBe(false);
    expect(can("auditor", "conflicts:review")).toBe(false);
    expect(can("reviewer", "fleet:read")).toBe(false);
    expect(can("device", "sync:write")).toBe(true);
    expect(can(undefined, "alerts:read")).toBe(false);
    expect(Object.keys(PERMISSIONS)).toHaveLength(5);
  });
  it("computes remaining session time", () => { expect(secondsLeft(decodeToken(makeToken({ exp: 1000 }))!, 400_000)).toBe(600); });
});

describe("helpers", () => {
  it("parses Prometheus text and sums labels", () => {
    const m = parseMetrics('# HELP x\nsync_batches_total{result="ok"} 3\nsync_batches_total{result="replay"} 1\nsync_open_alerts 2.0\nbad\ng NaN');
    expect(m.sync_batches_total).toBe(4);
    expect(m.sync_open_alerts).toBe(2);
    expect(m.g).toBeUndefined();
  });
  it("formats", () => {
    expect(fmtBytes(1536)).toBe("1.5 KB");
    expect(shortHash("a".repeat(64))).toContain("…");
    expect(fmtCountdown(75)).toBe("1:15");
    expect(relTime(0, 90_000)).toBe("1m ago");
  });
});
