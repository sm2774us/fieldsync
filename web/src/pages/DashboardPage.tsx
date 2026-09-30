import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertOctagon, GitCompareArrows, Radio, ShieldAlert, ShieldCheck, ShieldQuestion, Stamp, Timer, WifiOff } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { can } from "@/lib/auth";
import { parseMetrics } from "@/lib/metrics";
import { fmtBytes } from "@/lib/utils";
import { useSession } from "@/store/session";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ErrorState, PageHeader, Skeleton } from "@/components/ui/misc";
import { ConnBadge } from "./FleetPage";

function Kpi({ icon, label, value, tone, to, loading }: { icon: React.ReactNode; label: string; value: React.ReactNode; tone?: "danger" | "ok"; to?: string; loading?: boolean }) {
  const body = (
    <CardContent className="flex items-center gap-3">
      <span className={`grid size-10 place-items-center rounded-lg bg-muted ${tone === "danger" ? "text-danger" : tone === "ok" ? "text-success" : "text-accent"}`}>{icon}</span>
      <div><div className="text-xs text-muted-foreground">{label}</div>{loading ? <Skeleton className="mt-1 h-6 w-16" /> : <div className="text-xl font-semibold tabular-nums">{value}</div>}</div>
    </CardContent>
  );
  return <Card className={to ? "transition-colors hover:bg-muted/40" : ""}>{to ? <Link to={to}>{body}</Link> : body}</Card>;
}

export function DashboardPage() {
  const id = useSession((s) => s.identity)!;
  const ready = useQuery({ queryKey: ["ready"], queryFn: api.ready, refetchInterval: 15_000, retry: false });
  const metrics = useQuery({ queryKey: ["metrics"], queryFn: () => api.metricsText().then(parseMetrics), refetchInterval: 15_000 });
  const canFleet = can(id.role, "fleet:read");
  const fleet = useQuery({ queryKey: ["fleet"], queryFn: api.fleet, enabled: canFleet, refetchInterval: 15_000 });
  const verify = useMutation({ mutationFn: api.auditVerify, onSuccess: (r) => { if (r.ok) toast.success(`Audit chain intact (${r.entries} entries)`); else toast.error(`Audit chain BROKEN: ${r.error}`); }, onError: (e) => toast.error(e.message) });
  const checkpoint = useMutation({ mutationFn: api.auditCheckpoint, onSuccess: () => toast.success("Signed checkpoint recorded. Export it to your independent anchor store."), onError: (e) => toast.error(e.message) });
  const m = metrics.data ?? {};
  const count = (c: string) => fleet.data?.filter((d) => d.status === "active" && d.connectivity === c).length ?? 0;
  const worst = fleet.data?.filter((d) => d.status === "active").sort((a, b) => (b.oldest_pending_age_s ?? 0) - (a.oldest_pending_age_s ?? 0)).slice(0, 5) ?? [];
  const lag = Math.round(m.sync_max_sync_lag_seconds ?? 0);
  return (
    <>
      <PageHeader title="Sync operations" subtitle={`${id.agency} · signed in as ${id.sub} (${id.role})`}
        actions={<>
          {can(id.role, "audit:verify") ? <Button variant="outline" loading={verify.isPending} onClick={() => verify.mutate()}><ShieldCheck className="size-4" /> Verify audit chain</Button> : null}
          {can(id.role, "audit:checkpoint") ? <Button variant="outline" loading={checkpoint.isPending} onClick={() => checkpoint.mutate()}><Stamp className="size-4" /> Sign audit checkpoint</Button> : null}
        </>} />
      {ready.data && !ready.data.ready ? (
        <div role="alert" className="mb-4 flex items-start gap-3 rounded-lg border border-danger/50 bg-danger/10 p-4"><ShieldAlert className="mt-0.5 size-5 text-danger" /><div><b>Audit integrity failure.</b><p className="text-sm">{ready.data.audit_error}. Treat as a security incident. Do not alter data.</p></div></div>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi icon={<Radio className="size-5" />} label="Devices online" value={`${count("online")} / ${m.sync_devices_active ?? 0}`} to={canFleet ? "/fleet" : undefined} loading={metrics.isLoading} />
        <Kpi icon={<WifiOff className="size-5" />} label="Offline too long" value={m.sync_devices_offline ?? 0} tone={(m.sync_devices_offline ?? 0) ? "danger" : "ok"} to={canFleet ? "/fleet" : undefined} loading={metrics.isLoading} />
        <Kpi icon={<Timer className="size-5" />} label="Longest sync lag" value={lag < 90 ? `${lag}s` : `${Math.round(lag / 60)}m`} tone={lag > 900 ? "danger" : undefined} loading={metrics.isLoading} />
        <Kpi icon={<AlertOctagon className="size-5" />} label="Open alerts" value={m.sync_open_alerts ?? 0} tone={(m.sync_open_alerts ?? 0) ? "danger" : "ok"} to={can(id.role, "alerts:read") ? "/alerts" : undefined} loading={metrics.isLoading} />
        <Kpi icon={<ShieldQuestion className="size-5" />} label="In quarantine" value={m.sync_open_quarantine ?? 0} tone={(m.sync_open_quarantine ?? 0) ? "danger" : "ok"} to={can(id.role, "quarantine:read") ? "/quarantine" : undefined} loading={metrics.isLoading} />
        <Kpi icon={<GitCompareArrows className="size-5" />} label="Conflicts to review" value={m.sync_open_conflicts ?? 0} tone={(m.sync_open_conflicts ?? 0) ? "danger" : "ok"} to={can(id.role, "conflicts:read") ? "/conflicts" : undefined} loading={metrics.isLoading} />
        <Kpi icon={<ShieldAlert className="size-5" />} label="Blocked devices" value={m.sync_blocked_devices ?? 0} tone={(m.sync_blocked_devices ?? 0) ? "danger" : "ok"} loading={metrics.isLoading} />
        <Kpi icon={<ShieldCheck className="size-5" />} label="Events stored" value={m.sync_events_total ?? 0} loading={metrics.isLoading} />
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2"><CardHeader><CardTitle>Furthest behind</CardTitle>{canFleet ? <Button asChild size="sm" variant="ghost"><Link to="/fleet">Open fleet</Link></Button> : null}</CardHeader><CardContent>
          {!canFleet ? <p className="text-sm text-muted-foreground">Fleet status is not available to your role.</p> : fleet.isLoading ? <Skeleton className="h-24" /> : fleet.isError ? <ErrorState error={fleet.error} onRetry={() => fleet.refetch()} />
            : worst.length === 0 ? <p className="text-sm text-muted-foreground">No active devices yet.</p>
            : <ul className="divide-y">{worst.map((d) => <li key={d.device_id} className="flex flex-wrap items-center gap-3 py-2.5 text-sm"><Link to="/fleet/$id" params={{ id: d.device_id }} className="font-mono text-xs underline">{d.device_id}</Link><ConnBadge c={d.connectivity} /><span className="text-muted-foreground">backlog {d.queue_depth ?? "—"} · lag {d.oldest_pending_age_s ?? "—"}s</span></li>)}</ul>}
        </CardContent></Card>
        <Card><CardHeader><CardTitle>Pipeline health</CardTitle></CardHeader><CardContent className="space-y-2 text-sm">
          {[["Audit entries", ready.data?.audit_entries ?? "—"], ["Outbox pending", m.sync_outbox_pending ?? 0], ["Largest device backlog", m.sync_max_queue_depth ?? 0], ["Lowest storage free", `${Math.round((m.sync_min_storage_free_ratio ?? 1) * 100)}%`], ["Access denials", m.sync_authz_denied_total ?? 0], ["Heartbeats received", m.sync_heartbeats_total ?? 0]]
            .map(([k, v]) => <div key={String(k)} className="flex justify-between"><span className="text-muted-foreground">{k}</span><span className="tabular-nums">{v}</span></div>)}
          <p className="pt-2 text-xs text-muted-foreground">Refreshes every 15 s. Storage figures are reported by devices ({fmtBytes(0)} means none yet).</p>
        </CardContent></Card>
      </div>
    </>
  );
}
