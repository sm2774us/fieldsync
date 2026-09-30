import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmButton } from "../src/components/ui/misc";
import { FieldPage } from "../src/pages/FieldPage";
import { buildRouter } from "../src/router";
import { MemoryStore } from "../src/lib/sync/stores";
import { useSession } from "../src/store/session";
import { FakeServer } from "./fakeServer";
import { jsonResponse, makeToken } from "./helpers";

const fetchMock = vi.fn();
function routes(url: string): Response {
  if (url.includes("/readyz")) return jsonResponse({ ready: true, audit_entries: 12, audit_error: null });
  if (url.includes("/metrics")) return new Response("sync_devices_active 3\nsync_open_alerts 1\nsync_open_conflicts 2\n");
  if (url.includes("/v1/fleet")) return jsonResponse({ devices: [{ device_id: "unit-9", label: "Patrol 9", agency_id: "a", status: "active", sync_state: "ok", blocked_seq: null, acked_seq: 4, last_seen_ms: Date.now(), connectivity: "online", queue_depth: 2, oldest_pending_age_s: 30, storage_free_bytes: 50, storage_total_bytes: 1000, app_version: "1", retries: 0 }] });
  if (url.includes("/v1/alerts")) return jsonResponse({ alerts: [{ alert_id: "al_1", ts_ms: Date.now(), kind: "EVENT_QUARANTINED", severity: "high", object_id: "qt_1", status: "open", acked_by: null, acked_at_ms: null, detail: {} }] });
  return jsonResponse({ error: "not_found", message: "nope" }, 404);
}
beforeEach(() => { vi.stubGlobal("fetch", vi.fn((u: URL | string) => Promise.resolve(fetchMock(String(u)) ?? routes(String(u))))); fetchMock.mockReset(); fetchMock.mockImplementation(routes); });
afterEach(() => { vi.unstubAllGlobals(); useSession.getState().signOut(); });

const qc = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
function mount(path = "/") {
  const router = buildRouter(createMemoryHistory({ initialEntries: [path] }));
  return render(<QueryClientProvider client={qc()}><RouterProvider router={router} /></QueryClientProvider>);
}

describe("app shell", () => {
  it("redirects anonymous users to sign-in, rejects a bad token, then reaches the dashboard", async () => {
    mount("/");
    expect(await screen.findByRole("heading", { name: /fieldsync console/i })).toBeInTheDocument();
    const user = userEvent.setup();
    const box = screen.getByLabelText(/access token/i);
    await user.type(box, "not-a-token");
    await user.click(screen.getByRole("button", { name: /sign in/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/valid access token/i);
    await user.clear(box); await user.click(box); await user.paste(makeToken({ role: "supervisor" }));
    await user.click(screen.getByRole("button", { name: /sign in/i }));
    expect(await screen.findByRole("heading", { name: /sync operations/i })).toBeInTheDocument();
    expect(await screen.findByText("unit-9")).toBeInTheDocument();
  });

  it.each([
    ["supervisor", /Fleet[\s\S]*Records[\s\S]*Conflicts/, /Enrolment|Field app/],
    ["admin", /Enrolment/, /Fleet|Records|Audit log|Alerts/],
    ["device", /Field app/, /Fleet|Records|Conflicts|Quarantine/],
    ["reviewer", /Records[\s\S]*Conflicts[\s\S]*Quarantine/, /Fleet|Audit log|Enrolment/],
  ])("%s sees only what the role may use", async (role, yes, no) => {
    useSession.getState().signIn(makeToken({ role, sub: "who-1" }));
    mount("/");
    const nav = await screen.findByRole("navigation", { name: "Primary" });
    expect(nav).toHaveTextContent(yes);
    expect(nav).not.toHaveTextContent(no);
  });

  it("flags an audit integrity failure prominently", async () => {
    fetchMock.mockImplementation((u: string) => (u.includes("/readyz") ? jsonResponse({ ready: false, audit_entries: 3, audit_error: "hash mismatch at seq 2" }, 503) : routes(u)));
    useSession.getState().signIn(makeToken({ role: "auditor" }));
    mount("/");
    await waitFor(() => expect(screen.getAllByText(/audit integrity failure/i).length).toBeGreaterThan(0));
  });

  it("explains, instead of erroring, when a non-device opens the field app", async () => {
    useSession.getState().signIn(makeToken({ role: "auditor" }));
    mount("/field");
    expect(await screen.findByText(/field app is for devices/i)).toBeInTheDocument();
  });
});

describe("field app: the offline-first user journey", () => {
  it("saves while offline, shows Local only, then syncs to Acknowledged when back online", async () => {
    useSession.getState().signIn(makeToken({ role: "device", sub: "unit-1" }));
    const server = new FakeServer("unit-1");
    fetchMock.mockImplementation((u: string) => {
      if (u.includes("/cursor")) return jsonResponse({ acked_seq: server.acked, sync_state: "ok", blocked_seq: null });
      if (u.includes("/heartbeat")) return jsonResponse({ ok: true });
      return routes(u);
    });
    vi.stubGlobal("fetch", vi.fn(async (u: URL | string, init?: RequestInit) => {
      const url = String(u);
      if (url.includes("/v1/sync/batches")) {
        const body = JSON.parse(String(init?.body)) as { events: never[] };
        const r = await server.transport().send((init?.headers as Record<string, string>)["idempotency-key"]!, body.events);
        if (r.kind === "ok") return jsonResponse({ batch_id: "b", device_id: "unit-1", ack_through: r.ack_through, accepted: r.accepted, duplicates: r.duplicates, idempotent_replay: r.replay });
        return jsonResponse({ error: "x", message: "y" }, 500);
      }
      return Promise.resolve(fetchMock(url));
    }));
    const user = userEvent.setup();
    render(<QueryClientProvider client={qc()}><FieldPage storeFactory={async () => ({ store: new MemoryStore(), durable: true })} /></QueryClientProvider>);
    await user.click(await screen.findByRole("switch", { name: /simulate offline/i }));
    expect(screen.getByRole("status")).toHaveTextContent(/offline/i);
    await user.type(screen.getByLabelText("Title"), "Traffic stop");
    await user.type(screen.getByLabelText("Details"), "Vehicle 12, no injuries");
    await user.click(screen.getByRole("button", { name: /save on this device/i }));
    expect(await screen.findByText("Local only", { selector: "span.rounded-full" })).toBeInTheDocument();
    expect(server.events).toHaveLength(0);

    await user.click(screen.getByRole("switch", { name: /airplane mode/i }));
    await waitFor(() => expect(server.events).toHaveLength(1), { timeout: 8000 });
    expect(await screen.findByText("Acknowledged", { selector: "span.rounded-full" })).toBeInTheDocument();
  }, 15000);
});

describe("ConfirmButton (two-click safety for mutating actions)", () => {
  it("does not act on the first click, acts on the second, and disarms itself", async () => {
    const fn = vi.fn();
    render(<ConfirmButton label="Acknowledge" confirmLabel="Confirm ack" onConfirm={fn} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Acknowledge" }));
    expect(fn).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Confirm ack" }));
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it("disarms after 5 seconds", async () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    render(<ConfirmButton label="Revoke" onConfirm={fn} />);
    act(() => screen.getByRole("button", { name: "Revoke" }).click());
    expect(screen.getByRole("button", { name: "Confirm" })).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(5100); });
    expect(screen.getByRole("button", { name: "Revoke" })).toBeInTheDocument();
    vi.useRealTimers();
  });
});
