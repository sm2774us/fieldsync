import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { decodeToken, type Identity } from "@/lib/auth";

interface SessionState {
  token: string | null;
  identity: Identity | null;
  notice: string | null;
  signIn: (token: string) => Identity;
  signOut: (notice?: string) => void;
}

/** Bearer token lives in sessionStorage only: it dies with the tab and is never written to disk. */
export const useSession = create<SessionState>()(
  persist(
    (set) => ({
      token: null,
      identity: null,
      notice: null,
      signIn: (token) => {
        const id = decodeToken(token);
        if (!id) throw new Error("That does not look like a valid access token.");
        if (id.exp * 1000 <= Date.now()) throw new Error("That token has already expired.");
        set({ token: token.trim(), identity: id, notice: null });
        return id;
      },
      signOut: (notice) => {
        set({ token: null, identity: null, notice: notice ?? null });
        sessionStorage.removeItem("console-chat");
      },
    }),
    {
      name: "console-session",
      storage: createJSONStorage(() => sessionStorage),
      partialize: (s) => ({ token: s.token, identity: s.identity }),
    },
  ),
);

export type Theme = "dark" | "light" | "system";
interface PrefState {
  theme: Theme; recents: string[];
  setTheme: (t: Theme) => void; remember: (id: string) => void; clear: () => void;
}

export const usePrefs = create<PrefState>()(
  persist(
    (set) => ({
      theme: "dark",
      recents: [],
      setTheme: (theme) => set({ theme }),
      remember: (id) => set((s) => ({ recents: [id, ...s.recents.filter((x) => x !== id)].slice(0, 12) })),
      clear: () => set({ recents: [] }),
    }),
    { name: "console-prefs" },
  ),
);

export function applyTheme(theme: Theme) {
  const dark = theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}
