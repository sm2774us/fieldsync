import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { MotionConfig } from "motion/react";
import React from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";
import { ApiError } from "@/lib/api";
import { router } from "./router";
import { applyTheme, usePrefs, useSession } from "@/store/session";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      refetchOnWindowFocus: true,
      // Retry only what can succeed later: network faults and 5xx. Never 4xx (auth, permission, not found).
      retry: (n, e) => (e instanceof ApiError ? e.retryable && n < 2 : n < 1),
      retryDelay: (n) => Math.min(1000 * 2 ** n, 8000),
    },
  },
});

applyTheme(usePrefs.getState().theme);
// Sign-out (manual, expiry or 401) clears cached server data and returns to the login screen.
useSession.subscribe((s, prev) => {
  if (prev.token && !s.token) { queryClient.clear(); void router.navigate({ to: "/login" }); }
});

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <MotionConfig reducedMotion="user">
        <RouterProvider router={router} />
        <Toaster position="bottom-right" theme="system" richColors closeButton />
      </MotionConfig>
    </QueryClientProvider>
  </React.StrictMode>,
);
