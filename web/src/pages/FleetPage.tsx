import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { RefreshCw, ScanSearch } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { can } from "@/lib/auth";
import type { Connectivity, Device, ServerEvent } from "@/lib/types";
import { cn, fmtBytes, fmtTime, relTime } from "@/lib/utils";
import { useSession } from "@/store/session";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { EmptyState, ErrorState, HashChip, PageHeader, Skeleton } from "@/components/ui/misc";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const CONN: Record<Connectivity, { tone: "ok" | "info" | "danger" | "neutral"; label: string }> = {
  online: { tone: "ok", label: "online" }, delayed: { tone: "info", label: "delayed" }, offline: { tone: "danger", label: "offline" }, never: { tone: "neutral", label: "never connected" },
};
export const ConnBadge = ({ c }: { c: Connectivity }) => <Badge tone={CONN[c].tone}>{CONN[c].label}</Badge>;

function Free({ d }: { d: Device }) {
  if (!d.storage_total_bytes || d.storage_free_bytes == null) return <span className="text-muted-foreground">—</span>;
  const pct = Math.round((d.storage_free_bytes / d.storage_total_bytes) * 100);
  return (
    <span className="flex items-center gap-2" title={`${fmtBytes(d.storage_free_bytes)} free of ${fmtBytes(d.storage_total_bytes)}`}>
      <span className="h-1.5 w-16 overflow-hidden rounded-full bg-muted" role="img" aria-label={`${pct}% storage free`}><span className={cn("block h-full", pct < 10 ? "bg-danger" : "bg-success")} style={{ width: `${pct}%` }} /></span>
      <span className="text-xs tabular-nums">{pct}%</span>
    </span>
  );
}

export function FleetPage() {
  const role = useSession((s) => s.identity?.role);
  const nav = useNavigate();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["fleet"], queryFn: api.fleet, refetchInterval: 15_000 });
  const scan = useMutation({ mutationFn: api.scanFleet, onSuccess: (r) => { toast.success(`${r.alerts.length} new alert(s)`); void qc.invalidateQueries({ queryKey: ["alerts"] }); }, onError: (e) => toast.error(e.message) });
  const cols = React.useMemo<ColumnDef<Device, unknown>[]>(() => [
    { accessorKey: "device_id", header: "Device", cell: (c) => <span><b className="font-mono text-xs">{c.getValue<string>()}</b><div className="text-xs text-muted-foreground">{c.row.original.label}</div></span> },
    { accessorKey: "connectivity", header: "Link", cell: (c) => <ConnBadge c={c.getValue<Connectivity>()} /> },
    { accessorKey: "sync_state", header: "Sync", cell: (c) => c.row.original.status !== "active" ? <Badge>{c.row.original.status}</Badge> : c.getValue() === "blocked" ? <Badge tone="danger">blocked at #{c.row.original.blocked_seq}</Badge> : <Badge tone="ok">ok</Badge> },
    { accessorKey: "acked_seq", header: "Acked #", cell: (c) => <span className="tabular-nums">{c.getValue<number>()}</span> },
    { accessorKey: "queue_depth", header: "Backlog", cell: (c) => <span className="tabular-nums">{c.getValue<number | null>() ?? "—"}</span> },
    { accessorKey: "oldest_pending_age_s", header: "Sync lag", cell: (c) => { const v = c.getValue<number | null>(); return <span className="tabular-nums">{v == null ? "—" : v < 90 ? `${v}s` : `${Math.round(v / 60)}m`}</span>; } },
    { id: "free", header: "Storage free", enableSorting: false, cell: (c) => <Free d={c.row.original} /> },
    { accessorKey: "last_seen_ms", header: "Last seen", cell: (c) => { const v = c.getValue<number | null>(); return <span className="whitespace-nowrap text-xs" title={fmtTime(v)}>{v ? relTime(v) : "never"}</span>; } },
  ], []);
  return (
    <>
      <PageHeader title="Fleet" subtitle="Every device, whether it is reachable, and how far behind its data is."
        actions={<>
          {can(role, "fleet:scan") ? <Button variant="outline" loading={scan.isPending} onClick={() => scan.mutate()}><ScanSearch className="size-4" /> Scan fleet</Button> : null}
          <Button variant="outline" onClick={() => void q.refetch()} loading={q.isFetching}><RefreshCw className="size-4" /> Refresh</Button></>} />
      {q.isLoading ? <Skeleton className="h-64" /> : q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} />
        : <DataTable data={q.data!} columns={cols} onRowClick={(d) => void nav({ to: "/fleet/$id", params: { id: d.device_id } })} searchPlaceholder="Filter devices…" empty="No devices registered yet." />}
    </>
  );
}

const evCols: ColumnDef<ServerEvent, unknown>[] = [
  { accessorKey: "seq", header: "#" },
  { accessorKey: "type", header: "Type", cell: (c) => <span className="font-mono text-xs">{c.getValue<string>()}</span> },
  { accessorKey: "record_id", header: "Record", cell: (c) => <Link to="/records/$id" params={{ id: c.getValue<string>() }} className="font-mono text-xs underline">{c.getValue<string>()}</Link> },
  { accessorKey: "ts_ms", header: "Device time", cell: (c) => <span className="whitespace-nowrap text-xs">{fmtTime(c.getValue<number>())}</span> },
  { accessorKey: "received_ms", header: "Received", cell: (c) => <span className="whitespace-nowrap text-xs">{fmtTime(c.getValue<number>())}</span> },
  { accessorKey: "content_hash", header: "Hash", enableSorting: false, cell: (c) => <HashChip value={c.getValue<string>()} /> },
];

export function DeviceDetailPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const { tab } = useSearch({ strict: false }) as { tab?: string };
  const nav = useNavigate();
  const role = useSession((s) => s.identity?.role);
  const d = useQuery({ queryKey: ["device", id], queryFn: () => api.device(id), refetchInterval: 15_000 });
  const canEvents = can(role, "events:read");
  const ev = useQuery({ queryKey: ["device-events", id], queryFn: () => api.deviceEvents(id, 0, 500), enabled: canEvents && tab === "events" });
  if (d.isLoading) return <div className="space-y-3"><Skeleton className="h-10 w-72" /><Skeleton className="h-48" /></div>;
  if (d.isError) return <ErrorState error={d.error} onRetry={() => d.refetch()} />;
  const x = d.data!;
  const facts: [string, React.ReactNode][] = [
    ["Link", <ConnBadge key="c" c={x.connectivity} />], ["Last seen", x.last_seen_ms ? `${relTime(x.last_seen_ms)} (${fmtTime(x.last_seen_ms)})` : "never"],
    ["Acknowledged through", `#${x.acked_seq}`], ["Sync state", x.sync_state === "blocked" ? `blocked at #${x.blocked_seq}: awaiting review` : "ok"],
    ["Reported backlog", x.queue_depth ?? "—"], ["Oldest unsynced event", x.oldest_pending_age_s == null ? "—" : `${x.oldest_pending_age_s}s`],
    ["Storage", x.storage_total_bytes ? `${fmtBytes(x.storage_free_bytes ?? 0)} free of ${fmtBytes(x.storage_total_bytes)}` : "—"], ["App version / retries", `${x.app_version ?? "—"} / ${x.retries ?? "—"}`],
    ["Agency", x.agency_id], ["Registration", x.status],
  ];
  return (
    <>
      <PageHeader title={x.label} subtitle={x.device_id} actions={x.sync_state === "blocked" ? <Button asChild variant="danger"><Link to="/quarantine">Review quarantine</Link></Button> : undefined} />
      <Tabs value={tab ?? "overview"} onValueChange={(t) => void nav({ to: "/fleet/$id", params: { id }, search: { tab: t } })}>
        <TabsList><TabsTrigger value="overview">Overview</TabsTrigger>{canEvents ? <TabsTrigger value="events">Event log</TabsTrigger> : null}</TabsList>
        <TabsContent value="overview"><Card><CardContent><dl className="grid gap-3 text-sm sm:grid-cols-2">{facts.map(([k, v]) => <div key={k}><dt className="text-xs text-muted-foreground">{k}</dt><dd className="mt-0.5">{v}</dd></div>)}</dl></CardContent></Card></TabsContent>
        <TabsContent value="events"><Card><CardHeader><CardTitle>Acknowledged events (immutable, in device order)</CardTitle></CardHeader><CardContent>
          {ev.isLoading ? <Skeleton className="h-40" /> : ev.isError ? <ErrorState error={ev.error} onRetry={() => ev.refetch()} /> : ev.data!.length === 0 ? <EmptyState title="No events yet" hint="The device has not synchronised anything." />
            : <DataTable data={ev.data!} columns={evCols} pageSize={15} searchPlaceholder="Filter events…" />}
        </CardContent></Card></TabsContent>
      </Tabs>
    </>
  );
}
