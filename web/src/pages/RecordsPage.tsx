import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { ErrorState, PageHeader, Skeleton } from "@/components/ui/misc";
import { api } from "@/lib/api";
import type { RecordSummary } from "@/lib/types";
import { fmtTime, relTime } from "@/lib/utils";

const cols: ColumnDef<RecordSummary, unknown>[] = [
  { accessorKey: "record_id", header: "Record", cell: (c) => <span className="font-mono text-xs">{c.getValue<string>()}</span> },
  { id: "title", header: "Title", accessorFn: (r) => r.data.title, cell: (c) => <span>{c.getValue<string>()}</span> },
  { accessorKey: "version", header: "Version", cell: (c) => <Badge>v{c.getValue<number>()}</Badge> },
  { accessorKey: "created_by", header: "Created by device", cell: (c) => <span className="font-mono text-xs">{c.getValue<string>()}</span> },
  { accessorKey: "updated_ms", header: "Updated", cell: (c) => <span className="text-xs" title={fmtTime(c.getValue<number>())}>{relTime(c.getValue<number>())}</span> },
];

export function RecordsPage() {
  const nav = useNavigate();
  const q = useQuery({ queryKey: ["records"], queryFn: api.records, refetchInterval: 20_000 });
  return (
    <>
      <PageHeader title="Records" subtitle="Current state built from acknowledged events. Every version keeps its origin device and sequence number." />
      {q.isLoading ? <Skeleton className="h-64" /> : q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} />
        : <DataTable data={q.data!} columns={cols} onRowClick={(r) => void nav({ to: "/records/$id", params: { id: r.record_id } })} searchPlaceholder="Filter records…" empty="No records yet." />}
    </>
  );
}

export function RecordDetailPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const q = useQuery({ queryKey: ["record", id], queryFn: () => api.record(id) });
  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const r = q.data!;
  return (
    <>
      <PageHeader title={r.data.title ?? r.record_id} subtitle={`${r.record_id} · version ${r.version}`} />
      {r.conflicts.some((c) => c.status === "open") ? <div role="status" className="mb-4 rounded-lg border border-warning/50 bg-warning/10 p-3 text-sm">This record has an open conflict awaiting review. <Link to="/conflicts" className="underline">Review conflicts</Link></div> : null}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card><CardHeader><CardTitle>Current content</CardTitle></CardHeader><CardContent className="space-y-2 text-sm">{Object.entries(r.data).map(([k, v]) => <div key={k}><div className="text-xs text-muted-foreground">{k}</div><div className="whitespace-pre-wrap">{v}</div></div>)}</CardContent></Card>
        <Card><CardHeader><CardTitle>Version history (append-only)</CardTitle></CardHeader><CardContent><ol className="space-y-2 text-sm">
          {r.versions.map((v) => <li key={v.version} className="rounded-md border p-2"><b>v{v.version}</b> <Badge>{v.cause}</Badge><div className="text-xs text-muted-foreground">{fmtTime(v.ts_ms)} · {v.device_id ? `${v.device_id} #${v.seq}` : "reviewer decision"}</div></li>)}
        </ol></CardContent></Card>
        <Card className="lg:col-span-2"><CardHeader><CardTitle>Notes ({r.notes.length})</CardTitle></CardHeader><CardContent><ul className="space-y-2 text-sm">
          {r.notes.length === 0 ? <li className="text-muted-foreground">No notes.</li> : r.notes.map((n) => <li key={`${n.device_id}-${n.seq}`}>{n.text} <span className="text-xs text-muted-foreground">· {n.device_id} #{n.seq} · {fmtTime(n.ts_ms)}</span></li>)}</ul></CardContent></Card>
      </div>
    </>
  );
}
