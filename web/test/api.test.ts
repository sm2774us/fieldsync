import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "../src/lib/api";
import { useSession } from "../src/store/session";
import { jsonResponse, makeToken } from "./helpers";

const fetchMock = vi.fn();
beforeEach(() => { vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset(); useSession.getState().signIn(makeToken()); });
afterEach(() => { vi.unstubAllGlobals(); useSession.getState().signOut(); });

describe("api client", () => {
  it("sends the bearer token and never cookies", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ alerts: [] }));
    await api.alerts("open");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/v1/alerts?status=open");
    expect(init.headers.authorization).toMatch(/^Bearer /);
    expect(init.credentials).toBe("omit");
  });
  it("maps service errors, keeps the request id, and marks 4xx non-retryable", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "forbidden", message: "missing permission x" }, 403, { "x-request-id": "rid-1" }));
    expect(await api.alerts("open").catch((x: unknown) => x)).toMatchObject({ status: 403, code: "forbidden", requestId: "rid-1", retryable: false });
  });
  it("marks network failure and 5xx as retryable", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    expect(await api.alerts("open").catch((x: unknown) => x)).toMatchObject({ status: 0, code: "network", retryable: true });
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "boom", message: "x" }, 502));
    expect(await api.alerts("open").catch((x: unknown) => x)).toBeInstanceOf(ApiError);
  });
  it("signs the user out on 401", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "unauthenticated", message: "token expired" }, 401));
    await api.alerts("open").catch(() => undefined);
    expect(useSession.getState().token).toBeNull();
  });
  it("surfaces a broken audit chain from /readyz 503", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ready: false, audit_entries: 7, audit_error: "hash mismatch at seq 2" }, 503));
    expect(await api.ready()).toEqual({ ready: false, audit_entries: 7, audit_error: "hash mismatch at seq 2" });
  });
  it("times out instead of hanging", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation((_u: unknown, init: RequestInit) => new Promise((_r, rej) => init.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")))));
    const p = api.ready().catch((x: unknown) => x);
    await vi.advanceTimersByTimeAsync(6100);
    expect(await p).toMatchObject({ code: "timeout", status: 0 });
    vi.useRealTimers();
  });
});

describe("sendBatch never throws: every outcome the engine must tell apart is a value", () => {
  const send = () => api.sendBatch("unit-1", "key-000001", [{ seq: 1 }]);
  it("ok, with the idempotency header sent", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ack_through: 3, accepted: 2, duplicates: 1, idempotent_replay: true }));
    expect(await send()).toEqual({ kind: "ok", ack_through: 3, accepted: 2, duplicates: 1, replay: true });
    expect(fetchMock.mock.calls[0]![1].headers["idempotency-key"]).toBe("key-000001");
  });
  it.each([
    [409, { error: "sequence_gap", message: "gap", expected_seq: 4, ack_through: 3 }, { kind: "gap", expected_seq: 4, ack_through: 3 }],
    [422, { error: "integrity_failure", message: "m", seq: 2, reason: "hash_mismatch", ack_through: 1 }, { kind: "rejected", seq: 2, reason: "hash_mismatch", ack_through: 1, message: "m" }],
    [409, { error: "conflict", message: "blocked", blocked_seq: 2, ack_through: 1 }, { kind: "blocked", blocked_seq: 2, ack_through: 1 }],
    [503, { error: "x", message: "y" }, { kind: "network" }],
    [401, { error: "unauthenticated", message: "no" }, { kind: "auth" }],
  ])("HTTP %i maps to %j", async (status, body, want) => {
    fetchMock.mockResolvedValue(jsonResponse(body, status));
    expect(await send()).toMatchObject(want);
  });
  it("network failure", async () => {
    fetchMock.mockRejectedValue(new TypeError("offline"));
    expect(await send()).toEqual({ kind: "network" });
  });
});

describe("request shapes for every endpoint the console uses", () => {
  const cases: [string, () => Promise<unknown>, string, string][] = [
    ["fleet", () => api.fleet(), "GET", "/v1/fleet"],
    ["device", () => api.device("unit-1"), "GET", "/v1/devices/unit-1"],
    ["events", () => api.deviceEvents("unit-1", 5, 10), "GET", "/v1/devices/unit-1/events?after=5&limit=10"],
    ["scan", () => api.scanFleet(), "POST", "/v1/fleet/scan"],
    ["register", () => api.registerDevice({ device_id: "u", label: "l", agency_id: "a" }), "POST", "/v1/devices"],
    ["activate", () => api.activateDevice("u"), "POST", "/v1/devices/u/activate"],
    ["revoke", () => api.revokeDevice("u", "lost"), "POST", "/v1/devices/u/revoke?reason=lost"],
    ["records", () => api.records(), "GET", "/v1/records"],
    ["record", () => api.record("rec-1"), "GET", "/v1/records/rec-1"],
    ["conflicts", () => api.conflicts("open"), "GET", "/v1/conflicts?status=open"],
    ["resolve", () => api.resolveConflict("cf_1", "keep_current", "reason text"), "POST", "/v1/conflicts/cf_1/resolve"],
    ["quarantine", () => api.quarantine("open"), "GET", "/v1/quarantine?status=open"],
    ["disposition", () => api.disposition("qt_1", "retry_authorized", "reason text"), "POST", "/v1/quarantine/qt_1/disposition"],
    ["ack", () => api.ackAlert("al_1"), "POST", "/v1/alerts/al_1/ack"],
    ["audit", () => api.audit(0, 50), "GET", "/v1/audit?after=0&limit=50"],
    ["verify", () => api.auditVerify(), "POST", "/v1/audit/verify"],
    ["checkpoint", () => api.auditCheckpoint(), "POST", "/v1/audit/checkpoint"],
    ["cursor", () => api.cursor("unit-1"), "GET", "/v1/devices/unit-1/cursor"],
    ["heartbeat", () => api.heartbeat("unit-1", { queue_depth: 1 }), "POST", "/v1/devices/unit-1/heartbeat"],
    ["keys", () => api.keys(), "GET", "/v1/keys"],
    ["triage q", () => api.triage("quarantine", "qt_1"), "POST", "/v1/quarantine/qt_1/triage"],
    ["triage c", () => api.triage("conflicts", "cf_1"), "POST", "/v1/conflicts/cf_1/triage"],
    ["triage a", () => api.triage("alerts", "al_1"), "POST", "/v1/alerts/al_1/triage"],
  ];
  it.each(cases)("%s", async (_n, call, method, path) => {
    fetchMock.mockResolvedValue(jsonResponse({ devices: [], events: [], records: [], conflicts: [], items: [], alerts: [] }));
    await call();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(init.method).toBe(method);
    expect(String(url).replace("http://localhost:3000", "")).toContain(path);
  });
  it("reads metrics as text without a token", async () => {
    fetchMock.mockResolvedValue(new Response("sync_open_alerts 1\n"));
    expect(await api.metricsText()).toContain("sync_open_alerts");
    expect(fetchMock.mock.calls[0]![1].headers.authorization).toBeUndefined();
  });
});
