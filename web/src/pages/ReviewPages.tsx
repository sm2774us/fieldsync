import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import * as React from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { can } from "@/lib/auth";
import { REASONS } from "@/lib/describe";
import { eventHash } from "@/lib/sync/engine";
import type { Conflict, QuarantineItem } from "@/lib/types";
import { fmtTime, relTime } from "@/lib/utils";
import { useSession } from "@/store/session";
import { Badge } from "@/components/ui/badge";
import { AdvisoryPanel } from "@/components/Advisory";
import { DataTable } from "@/components/ui/data-table";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input, Select } from "@/components/ui/input";
import { ConfirmButton, ErrorState, Field, HashChip, PageHeader, Skeleton } from "@/components/ui/misc";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

const KIND: Record<string, string> = {
  stale_base: "Edited from an out-of-date version",
  duplicate_create: "Same record created twice",
  missing_record: "Refers to a record that does not exist",
};

function Side({ title, data, tone }: { title: string; data: Record<string, unknown> | null; tone: string }) {
  return (
    <div className={`rounded-lg border p-3 ${tone}`}>
      <div className="mb-1 text-xs font-medium text-muted-foreground">{title}</div>
      {data ? Object.entries(data).map(([k, v]) => <div key={k} className="text-sm"><span className="text-muted-foreground">{k}: </span><span className="whitespace-pre-wrap break-words">{typeof v === "string" ? v : JSON.stringify(v)}</span></div>) : <span className="text-sm text-muted-foreground">none</span>}
    </div>
  );
}

export function ConflictsPage() {
  const role = useSession((s) => s.identity?.role);
  const qc = useQueryClient();
  const [status, setStatus] = React.useState<"open" | "resolved">("open");
  const [sel, setSel] = React.useState<Conflict | null>(null);
  const [decision, setDecision] = React.useState<"apply_proposed" | "keep_current">("keep_current");
  const [note, setNote] = React.useState("");
  const q = useQuery({ queryKey: ["conflicts", status], queryFn: () => api.conflicts(status), refetchInterval: 20_000 });
  const res = useMutation({
    mutationFn: () => api.resolveConflict(sel!.conflict_id, decision, note.trim()),
    onSuccess: () => { toast.success("Decision recorded; history preserved"); setSel(null); setNote(""); void qc.invalidateQueries({ queryKey: ["conflicts"] }); void qc.invalidateQueries({ queryKey: ["alerts"] }); },
    onError: (e) => toast.error(e.message),
  });
  const cols = React.useMemo<ColumnDef<Conflict, unknown>[]>(() => [
    { accessorKey: "kind", header: "Kind", cell: (c) => <Badge tone="warn">{KIND[c.getValue<string>()] ?? c.getValue<string>()}</Badge> },
    { accessorKey: "record_id", header: "Record", cell: (c) => <span className="font-mono text-xs">{c.getValue<string>()}</span> },
    { id: "src", header: "From", cell: (c) => <span className="font-mono text-xs">{c.row.original.device_id} #{c.row.original.seq}</span> },
    { id: "base", header: "Based on / now", cell: (c) => <span className="text-xs">v{c.row.original.base_version ?? "?"} / v{c.row.original.current_version ?? "?"}</span> },
    { accessorKey: "created_ms", header: "Opened", cell: (c) => <span className="text-xs">{relTime(c.getValue<number>())}</span> },
  ], []);
  const stale = sel?.kind === "stale_base";
  const proposed = sel ? ((sel.proposed as { changes?: Record<string, unknown> }).changes ?? sel.proposed) : null;
  return (
    <>
      <PageHeader title="Conflicts" subtitle="Divergent edits are never merged silently. A person decides, and the history keeps both sides." />
      <Tabs value={status} onValueChange={(v) => setStatus(v as typeof status)} className="mb-4"><TabsList><TabsTrigger value="open">Open</TabsTrigger><TabsTrigger value="resolved">Resolved</TabsTrigger></TabsList></Tabs>
      {q.isLoading ? <Skeleton className="h-64" /> : q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} />
        : <DataTable data={q.data!} columns={cols} onRowClick={(c) => { setSel(c); setDecision("keep_current"); }} empty={status === "open" ? "No conflicts to review." : "Nothing resolved yet."} />}
      <Dialog open={!!sel} onOpenChange={(o) => !o && setSel(null)}>
        <DialogContent title={sel ? KIND[sel.kind] ?? sel.kind : "Conflict"} description={sel ? `${sel.record_id} · opened ${fmtTime(sel.created_ms)}` : undefined} className="w-[min(94vw,52rem)]">
          {sel ? (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2"><Side title={`Current on the server (v${sel.current_version ?? "none"})`} data={sel.current} tone="" /><Side title={`Proposed by ${sel.device_id} #${sel.seq} (from v${sel.base_version ?? "?"})`} data={proposed} tone="border-warning/50" /></div>
              <AdvisoryPanel kind="conflicts" id={sel.conflict_id} />
              {sel.status === "resolved" ? <p className="text-sm text-muted-foreground">Resolved by {sel.resolved_by}: {sel.resolution}.</p>
                : can(role, "conflicts:review") ? (
                  <form className="space-y-3" onSubmit={(e) => e.preventDefault()}>
                    <Field label="Decision" htmlFor="cf-dec"><Select id="cf-dec" value={decision} onChange={(e) => setDecision(e.target.value as typeof decision)}>
                      <option value="keep_current">Keep the current version (dismiss the proposal)</option>{stale ? <option value="apply_proposed">Apply the proposed change as a new version</option> : null}</Select></Field>
                    <Field label="Reason (min 8 characters)" htmlFor="cf-note"><Input id="cf-note" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
                    <ConfirmButton size="md" variant="primary" label="Record decision" confirmLabel="Confirm and record" disabled={note.trim().length < 8} loading={res.isPending} onConfirm={() => res.mutate()} />
                  </form>) : <p className="text-sm text-muted-foreground">Your role can view but not decide conflicts.</p>}
            </div>) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

function Hashes({ item }: { item: QuarantineItem }) {
  const [computed, setComputed] = React.useState<string>("…");
  React.useEffect(() => {
    let live = true;
    void eventHash(item.device_id, item.event as never).then((h) => live && setComputed(h));
    return () => { live = false; };
  }, [item]);
  return (
    <div className="space-y-1 text-xs">
      <div className="flex items-center gap-2"><span className="w-28 text-muted-foreground">Claimed hash</span><HashChip value={item.event.content_hash} /></div>
      <div className="flex items-center gap-2"><span className="w-28 text-muted-foreground">Computed here</span><HashChip value={computed} />{computed !== "…" ? <Badge tone={computed === item.event.content_hash ? "ok" : "danger"}>{computed === item.event.content_hash ? "match" : "differs"}</Badge> : null}</div>
    </div>
  );
}

export function QuarantinePage() {
  const role = useSession((s) => s.identity?.role);
  const qc = useQueryClient();
  const [status, setStatus] = React.useState<"open" | "retry_authorized" | "skip_authorized">("open");
  const [sel, setSel] = React.useState<QuarantineItem | null>(null);
  const [decision, setDecision] = React.useState<"retry_authorized" | "skip_authorized">("retry_authorized");
  const [note, setNote] = React.useState("");
  const q = useQuery({ queryKey: ["quarantine", status], queryFn: () => api.quarantine(status), refetchInterval: 20_000 });
  const disp = useMutation({
    mutationFn: () => api.disposition(sel!.quarantine_id, decision, note.trim()),
    onSuccess: () => { toast.success("Decision recorded. The device can sync again."); setSel(null); setNote(""); void qc.invalidateQueries({ queryKey: ["quarantine"] }); void qc.invalidateQueries({ queryKey: ["fleet"] }); void qc.invalidateQueries({ queryKey: ["alerts"] }); },
    onError: (e) => toast.error(e.message),
  });
  const cols = React.useMemo<ColumnDef<QuarantineItem, unknown>[]>(() => [
    { accessorKey: "reason", header: "Reason", cell: (c) => <Badge tone="danger">{c.getValue<string>().replaceAll("_", " ")}</Badge> },
    { id: "src", header: "Device / seq", cell: (c) => <span className="font-mono text-xs">{c.row.original.device_id} #{c.row.original.seq}</span> },
    { id: "type", header: "Event", cell: (c) => <span className="font-mono text-xs">{c.row.original.event.type}</span> },
    { accessorKey: "received_ms", header: "Received", cell: (c) => <span className="text-xs">{relTime(c.getValue<number>())}</span> },
    { accessorKey: "status", header: "Status", cell: (c) => <Badge>{c.getValue<string>().replaceAll("_", " ")}</Badge> },
  ], []);
  return (
    <>
      <PageHeader title="Quarantine" subtitle="Events that failed integrity or schema checks. Kept exactly as received, never applied, and the device is held until a person decides." />
      <Tabs value={status} onValueChange={(v) => setStatus(v as typeof status)} className="mb-4"><TabsList><TabsTrigger value="open">Awaiting review</TabsTrigger><TabsTrigger value="retry_authorized">Retry authorised</TabsTrigger><TabsTrigger value="skip_authorized">Skipped</TabsTrigger></TabsList></Tabs>
      {q.isLoading ? <Skeleton className="h-64" /> : q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} />
        : <DataTable data={q.data!} columns={cols} onRowClick={setSel} empty="Nothing here. Every event passed verification." />}
      <Dialog open={!!sel} onOpenChange={(o) => !o && setSel(null)}>
        <DialogContent title={sel ? `${sel.device_id} #${sel.seq}` : "Quarantined event"} description={sel ? REASONS[sel.reason] : undefined} className="w-[min(94vw,52rem)]">
          {sel ? (
            <div className="space-y-4">
              {sel.reason === "hash_mismatch" ? <Hashes item={sel} /> : null}
              <div><div className="mb-1 text-xs text-muted-foreground">The event exactly as received (immutable)</div><pre className="max-h-56 overflow-auto rounded-md bg-muted p-3 text-xs">{JSON.stringify(sel.event, null, 2)}</pre></div>
              <AdvisoryPanel kind="quarantine" id={sel.quarantine_id} />
              {sel.detail.detail ? <p className="text-sm text-muted-foreground">{sel.detail.detail}</p> : null}
              {sel.status !== "open" ? <p className="text-sm text-muted-foreground">Reviewed by {sel.reviewed_by}: {sel.review_note}</p>
                : can(role, "quarantine:review") ? (
                  <form className="space-y-3" onSubmit={(e) => e.preventDefault()}>
                    <Field label="Decision" htmlFor="q-dec"><Select id="q-dec" value={decision} onChange={(e) => setDecision(e.target.value as typeof decision)}>
                      <option value="retry_authorized">Authorise a retry (the device resends the original)</option><option value="skip_authorized">Skip this sequence number (retained, never applied)</option></Select></Field>
                    <Field label="Reason (min 8 characters)" htmlFor="q-note"><Input id="q-note" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
                    <ConfirmButton size="md" variant="primary" label="Record decision" confirmLabel="Confirm and record" disabled={note.trim().length < 8} loading={disp.isPending} onConfirm={() => disp.mutate()} />
                    <p className="text-xs text-muted-foreground">The received bytes stay preserved either way. Your decision joins the audit log.</p>
                  </form>) : <p className="text-sm text-muted-foreground">Your role can view but not review quarantined events.</p>}
            </div>) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
