import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdvisoryPanel } from "../src/components/Advisory";
import { useSession } from "../src/store/session";
import { jsonResponse, makeToken } from "./helpers";

const fetchMock = vi.fn();
beforeEach(() => { vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset(); });
afterEach(() => { vi.unstubAllGlobals(); useSession.getState().signOut(); });
const view = (role: string) => { useSession.getState().signIn(makeToken({ role })); return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><AdvisoryPanel kind="quarantine" id="qt_1" /></QueryClientProvider>); };
const advisory = { category: "integrity_failure", severity: "high", summary: "Event bytes do not match.", reasons: ["Altered in transit."], recommended_actions: ["retain_for_investigation", "request_device_resend"], source: "rules", model: null, prompt_sha256: null };

describe("advisory panel", () => {
  it("shows rule-based advice in plain words and calls the right endpoint", async () => {
    fetchMock.mockResolvedValue(jsonResponse(advisory));
    view("reviewer");
    await userEvent.setup().click(screen.getByRole("button", { name: /get advisory/i }));
    expect(await screen.findByText("Event bytes do not match.")).toBeInTheDocument();
    expect(screen.getByText("Ask the device to resend the original")).toBeInTheDocument();
    expect(screen.getByText("rules")).toBeInTheDocument();
    expect(String(fetchMock.mock.calls[0]![0])).toContain("/v1/quarantine/qt_1/triage");
    expect(fetchMock.mock.calls[0]![1].method).toBe("POST");
  });
  it("labels AI-enriched advice with the model", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ...advisory, source: "rules+llm", model: "claude-sonnet-5-5" }));
    view("supervisor");
    await userEvent.setup().click(screen.getByRole("button", { name: /get advisory/i }));
    expect(await screen.findByText(/rules \+ AI \(claude-sonnet-5-5\)/)).toBeInTheDocument();
  });
  it("is absent for roles without the permission", () => {
    view("admin");
    expect(screen.queryByRole("button", { name: /advisory/i })).toBeNull();
  });
  it("shows a service error instead of failing silently", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "not_found", message: "quarantine item not found" }, 404));
    view("auditor");
    await userEvent.setup().click(screen.getByRole("button", { name: /get advisory/i }));
    expect(await screen.findByText(/quarantine item not found/i)).toBeInTheDocument();
  });
});
