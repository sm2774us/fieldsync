import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { RefreshCw, ScanSearch } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { can } from "@/lib/auth";
import { describeAlert } from "@/lib/describe";
import type { Alert } from "@/lib/types";
import { fmtTime, relTime } from "@/lib/utils";
import { useSession } from "@/store/session";
import { SeverityBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { ConfirmButton, ErrorState, HashChip, PageHeader, Skeleton } from "@/components/ui/misc";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

const ORDER = { critical: 0, high: 1, medium: 2, low: 3 } as const;

export function AlertsPage() {
  const role = useSession((s) => s.identity?.role);
  const qc = useQueryClient();
  const [status, setStatus] = React.useState<"open" | "acknowledged">("open");
  const [sel, setSel] = React.useState<Alert | null>(null);
  const q = useQuery({ queryKey: ["alerts", status], queryFn: () => api.alerts(status), refetchInterval: 30_000 });
  const done = () => void qc.invalidateQueries({ queryKey: ["alerts"] });
  const ack = useMutation({ mutationFn: (id: string) => api.ackAlert(id), onSuccess: () => { toast.success("Alert acknowledged and recorded"); done(); setSel(null); }, onError: (e) => toast.error(e.message) });
  const scan = useMutation({ mutationFn: api.scanFleet, onSuccess: (r) => { toast.success(`${r.alerts.length} new alert(s) from the fleet scan`); done(); }, onError: (e) => toast.error(e.message) });
  const cols = React.useMemo<ColumnDef<Alert, unknown>[]>(() => [
    { accessorKey: "severity", header: "Severity", sortingFn: (a, b) => ORDER[a.original.severity] - ORDER[b.original.severity], cell: (c) => <SeverityBadge severity={c.getValue<string>()} /> },
    { accessorKey: "kind", header: "Kind", cell: (c) => <span className="font-mono text-xs">{c.getValue<string>()}</span> },
    { id: "summary", header: "What it means", enableSorting: false, cell: (c) => <span className="line-clamp-2 max-w-md text-muted-foreground">{describeAlert(c.row.original)}</span> },
    { accessorKey: "object_id", header: "Object", enableSorting: false, cell: (c) => <HashChip value={c.getValue<string>()} /> },
    { accessorKey: "ts_ms", header: "Raised", cell: (c) => <span title={fmtTime(c.getValue<number>())} className="whitespace-nowrap text-xs">{relTime(c.getValue<number>())}</span> },
  ], []);
  return (
    <>
      <PageHeader title="Alerts" subtitle="Deterministic checks on the fleet and the sync pipeline. Acknowledging records that a person has seen it."
        actions={<>
          {can(role, "fleet:scan") ? <Button variant="outline" loading={scan.isPending} onClick={() => scan.mutate()}><ScanSearch className="size-4" /> Scan fleet</Button> : null}
          <Button variant="outline" onClick={() => void q.refetch()} loading={q.isFetching}><RefreshCw className="size-4" /> Refresh</Button>
        </>} />
      <Tabs value={status} onValueChange={(v) => setStatus(v as typeof status)} className="mb-4"><TabsList><TabsTrigger value="open">Open</TabsTrigger><TabsTrigger value="acknowledged">Acknowledged</TabsTrigger></TabsList></Tabs>
      {q.isLoading ? <Skeleton className="h-64" /> : q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} />
        : <DataTable data={q.data!} columns={cols} onRowClick={setSel} empty={status === "open" ? "No open alerts. All clear." : "Nothing acknowledged yet."} />}
      <Dialog open={!!sel} onOpenChange={(o) => !o && setSel(null)}>
        <DialogContent title={sel?.kind ?? "Alert"} description={sel ? `Raised ${fmtTime(sel.ts_ms)}` : undefined}>
          {sel ? (
            <div className="space-y-3 text-sm">
              <SeverityBadge severity={sel.severity} />
              <p>{describeAlert(sel)}</p>
              <pre className="max-h-48 overflow-auto rounded-md bg-muted p-3 text-xs">{JSON.stringify(sel.detail, null, 2)}</pre>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">Object <HashChip value={sel.object_id} />
                {sel.kind.startsWith("DEVICE") || sel.kind.startsWith("BACKLOG") || sel.kind.startsWith("STORAGE") ? <Link className="underline" to="/fleet/$id" params={{ id: sel.object_id ?? "" }}>open device</Link> : null}
                {sel.kind === "CONFLICT_OPEN" ? <Link className="underline" to="/conflicts">open conflicts</Link> : null}
                {sel.kind === "EVENT_QUARANTINED" ? <Link className="underline" to="/quarantine">open quarantine</Link> : null}</div>
              {sel.status === "open" && can(role, "alerts:ack") ? <ConfirmButton size="md" variant="primary" label="Acknowledge alert" confirmLabel="Confirm acknowledge" loading={ack.isPending} onConfirm={() => ack.mutate(sel.alert_id)} />
                : sel.status !== "open" ? <p className="text-xs text-muted-foreground">Acknowledged by {sel.acked_by} {sel.acked_at_ms ? relTime(sel.acked_at_ms) : ""}.</p> : null}
            </div>) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
