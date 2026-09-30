import { useQuery } from "@tanstack/react-query";
import { Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { Activity, LogOut, Moon, Search, ShieldAlert, ShieldCheck, Sun, WifiOff } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import * as React from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { cn, fmtCountdown } from "@/lib/utils";
import { secondsLeft } from "@/lib/auth";
import { applyTheme, usePrefs, useSession } from "@/store/session";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/misc";
import { CommandPalette } from "./CommandPalette";
import { NAV, allowed } from "./nav";

function StatusPill() {
  const q = useQuery({ queryKey: ["ready"], queryFn: api.ready, refetchInterval: 15_000, retry: false });
  if (q.isError) return <Badge tone="warn"><WifiOff className="size-3" /> API unreachable</Badge>;
  if (!q.data) return <Badge><Activity className="size-3" /> checking…</Badge>;
  return q.data.ready
    ? <Badge tone="ok"><ShieldCheck className="size-3" /> audit chain intact</Badge>
    : <Badge tone="danger"><ShieldAlert className="size-3" /> AUDIT INTEGRITY FAILURE</Badge>;
}

function SessionChip() {
  const id = useSession((s) => s.identity)!;
  const signOut = useSession((s) => s.signOut);
  const [left, setLeft] = React.useState(() => secondsLeft(id));
  const warned = React.useRef(false);
  React.useEffect(() => {
    const t = setInterval(() => {
      const s = secondsLeft(id);
      setLeft(s);
      if (s <= 120 && s > 0 && !warned.current) { warned.current = true; toast.warning("Your session expires in under 2 minutes. Save your work."); }
      if (s <= 0) signOut("Your session expired. Sign in with a fresh token.");
    }, 1000);
    return () => clearInterval(t);
  }, [id, signOut]);
  return (
    <span className="hidden items-center gap-2 text-xs sm:flex" title={`${id.sub} @ ${id.agency}`}>
      <Badge tone="brand">{id.role}</Badge>
      <span className="max-w-32 truncate text-muted-foreground">{id.sub}</span>
      <span className={cn("font-mono", left < 120 ? "text-warning" : "text-muted-foreground")}>{fmtCountdown(left)}</span>
    </span>
  );
}

export function AppShell() {
  const identity = useSession((s) => s.identity);
  const signOut = useSession((s) => s.signOut);
  const theme = usePrefs((s) => s.theme);
  const setTheme = usePrefs((s) => s.setTheme);
  const nav = useNavigate();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const [palette, setPalette] = React.useState(false);
  const [online, setOnline] = React.useState(navigator.onLine);

  React.useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener("online", on); window.addEventListener("offline", off);
    const key = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPalette((p) => !p); } };
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); window.removeEventListener("keydown", key); };
  }, []);
  React.useEffect(() => applyTheme(theme), [theme]);

  const items = identity ? NAV.filter((n) => allowed(identity.role, n.perm)) : [];
  const dark = document.documentElement.classList.contains("dark");
  // Signing out (manual, expiry, 401) clears identity before the redirect lands: render nothing meanwhile.
  if (!identity) return null;

  return (
    <div className="flex h-full flex-col lg:flex-row">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:m-2 focus:rounded focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-foreground">Skip to content</a>
      <aside className="hidden w-60 shrink-0 flex-col border-r bg-card lg:flex">
        <div className="flex h-14 items-center gap-2 border-b px-4">
          <span className="grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground"><ShieldCheck className="size-4" /></span>
          <div className="leading-tight"><div className="text-sm font-semibold">FieldSync Console</div><div className="text-[10px] uppercase tracking-widest text-muted-foreground">offline-first sync</div></div>
        </div>
        <nav aria-label="Primary" className="flex-1 space-y-0.5 p-2">
          {items.map((n) => {
            const active = n.to === "/" ? path === "/" : path.startsWith(n.to);
            return (
              <Link key={n.to} to={n.to} aria-current={active ? "page" : undefined}
                className={cn("flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground", active && "bg-muted font-medium text-foreground")}>
                <n.icon className={cn("size-4", active && "text-accent")} />{n.label}
              </Link>
            );
          })}
        </nav>
        <p className="border-t p-3 text-[11px] leading-snug text-muted-foreground">Every action here is written to the tamper-evident audit log.</p>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-card/70 px-3 backdrop-blur sm:px-4">
          <span className="font-semibold lg:hidden">FieldSync Console</span>
          <Button variant="outline" size="sm" className="ml-auto hidden w-56 justify-between text-muted-foreground sm:flex" onClick={() => setPalette(true)} aria-label="Open command palette">
            <span className="flex items-center gap-2"><Search className="size-3.5" /> Search or run…</span><Kbd>Ctrl K</Kbd>
          </Button>
          <Button variant="ghost" size="icon" className="sm:hidden" onClick={() => setPalette(true)} aria-label="Open command palette"><Search className="size-4" /></Button>
          <StatusPill />
          <SessionChip />
          <Button variant="ghost" size="icon" aria-label="Toggle theme" onClick={() => setTheme(dark ? "light" : "dark")}>{dark ? <Sun className="size-4" /> : <Moon className="size-4" />}</Button>
          <Button variant="ghost" size="icon" aria-label="Sign out" onClick={() => { signOut(); void nav({ to: "/login", search: {} }); }}><LogOut className="size-4" /></Button>
        </header>
        <nav aria-label="Primary (compact)" className="flex gap-1 overflow-x-auto border-b bg-card px-2 py-1.5 lg:hidden">
          {items.map((n) => <Link key={n.to} to={n.to} className={cn("flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-muted-foreground", (n.to === "/" ? path === "/" : path.startsWith(n.to)) && "bg-muted text-foreground")}><n.icon className="size-3.5" />{n.label}</Link>)}
        </nav>
        {!online ? <div role="status" className="flex items-center gap-2 bg-warning/15 px-4 py-2 text-sm text-warning"><WifiOff className="size-4" /> You are offline. Data shown may be stale; actions will fail until the connection returns.</div> : null}
        <main id="main" tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto">
          <AnimatePresence mode="wait">
            <motion.div key={path.split("/")[1] ?? ""} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.16 }} className="mx-auto max-w-6xl p-4 sm:p-6">
              <Outlet />
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
      <CommandPalette open={palette} onOpenChange={setPalette} />
    </div>
  );
}
