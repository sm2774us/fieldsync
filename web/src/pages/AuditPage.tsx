import { useInfiniteQuery, useMutation } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { FastForward, ShieldCheck } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { can } from "@/lib/auth";
import type { AuditEntry } from "@/lib/types";
import { fmtTime } from "@/lib/utils";
import { useSession } from "@/store/session";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { ErrorState, HashChip, PageHeader, Skeleton } from "@/components/ui/misc";

const PAGE = 200;

export function AuditPage() {
  const role = useSession((s) => s.identity?.role);
  const [sel, setSel] = React.useState<AuditEntry | null>(null);
  const q = useInfiniteQuery({
    queryKey: ["audit"], initialPageParam: 0,
    queryFn: ({ pageParam }) => api.audit(pageParam, PAGE),
    getNextPageParam: (last) => (last.length === PAGE ? last[last.length - 1]!.seq : undefined),
  });
  const rows = React.useMemo(() => (q.data?.pages.flat() ?? []).slice().reverse(), [q.data]);
  const [jumping, setJumping] = React.useState(false);
  const jump = async () => { setJumping(true); try { for (let i = 0; i < 100 && q.hasNextPage; i++) { const r = await q.fetchNextPage(); if (!r.hasNextPage) break; } } finally { setJumping(false); } };
  const verify = useMutation({ mutationFn: api.auditVerify, onSuccess: (r) => (r.ok ? toast.success(`Chain intact: ${r.entries} entries, ${r.checkpoints_verified} checkpoints`) : toast.error(`Chain BROKEN: ${r.error}`)), onError: (e) => toast.error(e.message) });

  const cols = React.useMemo<ColumnDef<AuditEntry, unknown>[]>(() => [
    { accessorKey: "seq", header: "#" },
    { accessorKey: "ts_ms", header: "When", cell: (c) => <span className="whitespace-nowrap text-xs">{fmtTime(c.getValue<number>())}</span> },
    { accessorKey: "actor", header: "Actor", cell: (c) => <span>{c.getValue<string>()} <Badge>{c.row.original.actor_role}</Badge></span> },
    { accessorKey: "action", header: "Action", cell: (c) => <span className={`font-mono text-xs ${String(c.getValue()).includes("denied") || String(c.getValue()).includes("quarantined") ? "text-danger" : ""}`}>{c.getValue<string>()}</span> },
    { accessorKey: "object_id", header: "Object", cell: (c) => <HashChip value={c.getValue<string>()} /> },
    { accessorKey: "source_ip", header: "From", cell: (c) => <span className="text-xs text-muted-foreground">{c.getValue<string>()}</span> },
  ], []);

  return (
    <>
      <PageHeader title="Audit log" subtitle="Append-only and hash-chained. Sync batches are recorded as ranges; quarantines, conflicts and reviews individually."
        actions={<>
          {can(role, "audit:verify") ? <Button variant="outline" loading={verify.isPending} onClick={() => verify.mutate()}><ShieldCheck className="size-4" /> Verify chain</Button> : null}
        </>} />
      {q.isLoading ? <Skeleton className="h-72" /> : q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} />
        : <DataTable data={rows} columns={cols} onRowClick={setSel} pageSize={20} searchPlaceholder="Filter by actor, action, object…"
            toolbar={<div className="flex gap-2">
              <Button size="sm" variant="secondary" disabled={!q.hasNextPage} loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>Load older→newer ({PAGE})</Button>
              <Button size="sm" variant="secondary" disabled={!q.hasNextPage} loading={jumping} onClick={() => void jump()}><FastForward className="size-3.5" /> Load all</Button></div>} />}
      <p className="mt-2 text-xs text-muted-foreground">Showing newest first among loaded entries. {q.hasNextPage ? "More entries are available on the server." : "All entries loaded."}</p>
      <Dialog open={!!sel} onOpenChange={(o) => !o && setSel(null)}>
        <DialogContent title={`Entry #${sel?.seq ?? ""}`} description={sel?.action}>
          {sel ? <dl className="space-y-2 text-sm">
            {([["When", fmtTime(sel.ts_ms)], ["Actor", `${sel.actor} (${sel.actor_role})`], ["Object", `${sel.object_type} ${sel.object_id}`], ["Request ID", sel.request_id ?? "—"], ["Source", sel.source_ip ?? "—"]] as const).map(([k, v]) => <div key={k} className="flex justify-between gap-4"><dt className="text-muted-foreground">{k}</dt><dd className="break-all text-right">{v}</dd></div>)}
            <div className="flex justify-between"><dt className="text-muted-foreground">Previous hash</dt><dd><HashChip value={sel.prev_hash} /></dd></div>
            <div className="flex justify-between"><dt className="text-muted-foreground">Entry hash</dt><dd><HashChip value={sel.entry_hash} /></dd></div>
            <pre className="max-h-56 overflow-auto rounded-md bg-muted p-3 text-xs">{JSON.stringify(sel.detail, null, 2)}</pre>
          </dl> : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
