import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyTheme, usePrefs, useSession } from "../src/store/session";
import { makeToken } from "./helpers";

beforeEach(() => { useSession.getState().signOut(); usePrefs.setState({ theme: "dark", recents: [] }); });

describe("session store", () => {
  it("rejects malformed and expired tokens; accepts valid ones", () => {
    expect(() => useSession.getState().signIn("garbage")).toThrow(/valid access token/);
    expect(() => useSession.getState().signIn(makeToken({ exp: 10 }))).toThrow(/expired/);
    expect(useSession.getState().signIn(` ${makeToken({ role: "reviewer" })} `).role).toBe("reviewer");
    expect(useSession.getState().token).not.toContain(" ");
  });
  it("keeps the token in sessionStorage only", () => {
    useSession.getState().signIn(makeToken());
    expect(sessionStorage.getItem("console-session")).toContain("token");
    expect(localStorage.getItem("console-session")).toBeNull();
    useSession.getState().signOut("bye");
    expect(useSession.getState().notice).toBe("bye");
    expect(useSession.getState().token).toBeNull();
  });
  it("applies themes, honouring the system preference", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("dark"), addEventListener() {}, removeEventListener() {} }));
    applyTheme("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    applyTheme("system");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    vi.unstubAllGlobals();
  });
});
