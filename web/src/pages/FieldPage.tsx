import { CloudOff, Database, RefreshCw, ShieldCheck, Trash2, Wifi } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { can } from "@/lib/auth";
import { SyncEngine, backoffMs, type Stats } from "@/lib/sync/engine";
import { defaultStore, type StoreFactory } from "@/lib/sync/factory";
import type { StoredEvent, Transport } from "@/lib/sync/types";
import { cn, fmtTime } from "@/lib/utils";
import { useSession } from "@/store/session";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Select, Textarea } from "@/components/ui/input";
import { EmptyState, Field, HashChip, PageHeader } from "@/components/ui/misc";

const LABEL = { local: "Local only", uploading: "Uploading", acked: "Acknowledged", failed: "Failed" } as const;
const TONE = { local: "warn", uploading: "info", acked: "ok", failed: "danger" } as const;

const newId = (p: string) => `${p}-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;

export function FieldPage({ storeFactory = defaultStore }: { storeFactory?: StoreFactory }) {
  const identity = useSession((s) => s.identity);
  // Sign-out clears the identity before the router redirects: render nothing in that window.
  return identity ? <FieldApp identity={identity} storeFactory={storeFactory} /> : null;
}

function FieldApp({ identity, storeFactory }: { identity: NonNullable<ReturnType<typeof useSession.getState>["identity"]>; storeFactory: StoreFactory }) {
  const deviceId = identity.sub;
  const [engine, setEngine] = React.useState<SyncEngine | null>(null);
  const [durable, setDurable] = React.useState(true);
  const [events, setEvents] = React.useState<StoredEvent[]>([]);
  const [stats, setStats] = React.useState<Stats | null>(null);
  const [airplane, setAirplane] = React.useState(false);
  const [browserOnline, setBrowserOnline] = React.useState(navigator.onLine);
  const [status, setStatus] = React.useState("Idle");
  const [syncing, setSyncing] = React.useState(false);
  const [mode, setMode] = React.useState<"report.create" | "note.add" | "report.update">("report.create");
  const [title, setTitle] = React.useState("");
  const [body, setBody] = React.useState("");
  const [target, setTarget] = React.useState("");
  const online = !airplane && browserOnline;
  const onlineRef = React.useRef(online);
  React.useEffect(() => { onlineRef.current = online; }, [online]);
  const attempt = React.useRef(0);

  React.useEffect(() => {
    const on = () => setBrowserOnline(true), off = () => setBrowserOnline(false);
    window.addEventListener("online", on); window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, []);

  React.useEffect(() => {
    let live = true;
    void storeFactory(deviceId).then(({ store, durable: d }) => {
      if (!live) return;
      const transport: Transport = {
        // "Airplane mode" is enforced at the transport, so the demo exercises the real failure path.
        cursor: () => (onlineRef.current ? api.cursor(deviceId) : Promise.reject(new Error("offline"))),
        send: (key, evs) => (onlineRef.current ? api.sendBatch(deviceId, key, evs) : Promise.resolve({ kind: "network" as const })),
      };
      setDurable(d);
      setEngine(new SyncEngine({ deviceId, store, transport, batchSize: 25 }));
    });
    return () => { live = false; };
  }, [deviceId, storeFactory]);

  const refresh = React.useCallback(async () => {
    if (!engine) return;
    setStats(await engine.stats());
    setEvents((await engine.store.all()).reverse());
  }, [engine]);

  const runSync = React.useCallback(async () => {
    if (!engine) return;
    setSyncing(true);
    try {
      const r = await engine.syncOnce();
      attempt.current = r.status === "offline" ? attempt.current + 1 : 0;
      setStatus(r.status === "ok" ? (r.acked ? `Synchronised ${r.acked} event(s)` : "Up to date")
        : r.status === "offline" ? "Cannot reach the service. Your work is safe on this device; retrying with backoff."
        : r.status === "blocked" ? "Sync is paused: a reviewer must clear a quarantined event."
        : r.status === "auth" ? "Your session is no longer valid." : `An event was rejected (${r.status === "rejected" ? r.reason : "unknown"}). It is kept locally.`);
    } finally { setSyncing(false); await refresh(); }
  }, [engine, refresh]);

  // Automatic sync loop: immediate when online, exponential backoff with jitter when the link fails.
  React.useEffect(() => {
    if (!engine) return;
    let stop = false, timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (stop) return;
      if (onlineRef.current) {
        const s = await engine.stats();
        if (s.local + s.uploading > 0) await runSync(); else await refresh();
      } else await refresh();
      timer = setTimeout(() => void tick(), onlineRef.current ? (attempt.current ? backoffMs(attempt.current) : 4000) : 1500);
    };
    void tick();
    return () => { stop = true; clearTimeout(timer); };
  }, [engine, runSync, refresh]);

  // Heartbeat: tells operators this device is alive, how deep its queue is and how full its disk is.
  React.useEffect(() => {
    if (!engine) return;
    const beat = async () => {
      if (!onlineRef.current) return;
      const s = await engine.stats();
      const est = (await navigator.storage?.estimate?.()) ?? {};
      try { await api.heartbeat(deviceId, { queue_depth: s.queueDepth, oldest_pending_age_s: s.oldestPendingAgeS, storage_free_bytes: Math.max(0, (est.quota ?? 1e9) - (est.usage ?? 0)), storage_total_bytes: est.quota ?? 1e9, app_version: "1.0.0", retries: engine.retries }); } catch { /* next beat */ }
    };
    void beat();
    const t = setInterval(() => void beat(), 30_000);
    return () => clearInterval(t);
  }, [engine, deviceId]);

  const records = React.useMemo(() => {
    const m = new Map<string, { title: string; version: number }>();
    for (const e of [...events].reverse()) {
      if (e.env.type === "report.create") m.set(e.env.record_id, { title: String(e.env.payload.title), version: 1 });
      else if (e.env.type === "report.update") { const r = m.get(e.env.record_id); if (r) m.set(e.env.record_id, { title: String(e.env.payload.changes && (e.env.payload.changes as Record<string, string>).title || r.title), version: r.version + 1 }); }
    }
    return m;
  }, [events]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!engine) return;
    try {
      if (mode === "report.create") await engine.append("report.create", newId("rpt"), { title: title.trim(), body: body.trim() });
      else if (mode === "note.add") await engine.append("note.add", target, { text: body.trim() });
      else await engine.append("report.update", target, { changes: { title: title.trim() } }, { baseVersion: records.get(target)?.version ?? 1 });
      setTitle(""); setBody("");
      toast.success(online ? "Saved on this device. Syncing…" : "Saved on this device. It will upload when you are back online.");
      await refresh();
      if (onlineRef.current) void runSync();
    } catch (x) { toast.error(x instanceof Error ? x.message : "Could not save"); }
  };

  if (!can(identity.role, "sync:write")) return <EmptyState title="The field app is for devices" hint="Sign in with a device token (role “device”) to author events offline. Other roles use Fleet, Records and Conflicts." />;
  const needsTarget = mode !== "report.create";
  const valid = mode === "report.create" ? title.trim() && body.trim() : mode === "note.add" ? target && body.trim() : target && title.trim();
  const c = stats ?? { local: 0, uploading: 0, acked: 0, failed: 0, queueDepth: 0, oldestPendingAgeS: 0 };
  return (
    <>
      <PageHeader title="Field app" subtitle={`${deviceId} · works without a connection; everything is saved here first, then synchronised in order.`}
        actions={<>
          <Button variant={airplane ? "danger" : "outline"} role="switch" aria-checked={airplane} onClick={() => { setAirplane((a) => !a); attempt.current = 0; }}>{airplane ? <CloudOff className="size-4" /> : <Wifi className="size-4" />} {airplane ? "Airplane mode: on" : "Simulate offline"}</Button>
          <Button variant="outline" loading={syncing} disabled={!online || !engine} onClick={() => void runSync()}><RefreshCw className="size-4" /> Sync now</Button>
        </>} />
      <div role="status" aria-live="polite" className={cn("mb-4 flex flex-wrap items-center gap-3 rounded-lg border p-3 text-sm", online ? "border-success/40 bg-success/5" : "border-warning/50 bg-warning/10")}>
        {online ? <Wifi className="size-4 text-success" /> : <CloudOff className="size-4 text-warning" />}
        <b>{online ? "Online" : "Offline"}</b><span className="text-muted-foreground">{status}</span>
        <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground"><Database className="size-3.5" />{durable ? "Encrypted, durable local storage" : "Storage unavailable: data is kept in memory only"}</span>
      </div>
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {(["local", "uploading", "acked", "failed"] as const).map((k) => <Card key={k}><CardContent className="py-3"><div className="text-xs text-muted-foreground">{LABEL[k]}</div><div className={cn("text-2xl font-semibold tabular-nums", k === "failed" && c[k] ? "text-danger" : "")}>{c[k]}</div></CardContent></Card>)}
      </div>
      <div className="grid gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-2"><CardHeader><CardTitle>New entry</CardTitle></CardHeader><CardContent>
          <form className="space-y-3" onSubmit={(e) => void submit(e)}>
            <Field label="What are you recording?" htmlFor="mode"><Select id="mode" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}><option value="report.create">New report</option><option value="note.add">Add a note to a report</option><option value="report.update">Change a report title</option></Select></Field>
            {needsTarget ? <Field label="Report" htmlFor="target"><Select id="target" value={target} onChange={(e) => setTarget(e.target.value)}><option value="">Choose…</option>{[...records].map(([id, r]) => <option key={id} value={id}>{r.title} (v{r.version})</option>)}</Select></Field> : null}
            {mode !== "note.add" ? <Field label={mode === "report.create" ? "Title" : "New title"} htmlFor="title"><Input id="title" maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} /></Field> : null}
            {mode !== "report.update" ? <Field label={mode === "report.create" ? "Details" : "Note"} htmlFor="body"><Textarea id="body" maxLength={mode === "note.add" ? 2000 : 20000} value={body} onChange={(e) => setBody(e.target.value)} /></Field> : null}
            <Button type="submit" disabled={!valid || !engine}>Save on this device</Button>
          </form>
          <p className="mt-3 flex items-start gap-2 text-xs text-muted-foreground"><ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-success" />Each entry is numbered, hashed and written to encrypted storage before this screen confirms it. It is deleted from the device only after the server acknowledges it.</p>
        </CardContent></Card>
        <Card className="lg:col-span-3"><CardHeader><CardTitle>Event log</CardTitle>
          <Button size="sm" variant="ghost" disabled={!engine || c.acked < 1} onClick={() => void engine!.compact(200).then((n) => { toast.success(`${n} acknowledged event(s) cleared`); return refresh(); })}><Trash2 className="size-3.5" /> Clear old acknowledged</Button></CardHeader>
          <CardContent>{events.length === 0 ? <EmptyState title="Nothing recorded yet" hint="Turn on airplane mode and add a few entries to see them queue, then turn it off." /> : (
            <ol className="max-h-[28rem] space-y-2 overflow-y-auto" aria-label="Local event log">
              {events.slice(0, 100).map((e) => (
                <li key={e.seq} className="rounded-lg border p-2.5 text-sm">
                  <div className="flex flex-wrap items-center gap-2"><span className="font-mono text-xs text-muted-foreground">#{e.seq}</span><b className="font-mono text-xs">{e.env.type}</b><Badge tone={TONE[e.state]}>{LABEL[e.state]}</Badge>{e.attempts > 1 ? <span className="text-xs text-muted-foreground">{e.attempts} attempts</span> : null}<span className="ml-auto text-xs text-muted-foreground">{fmtTime(e.env.ts_ms)}</span></div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><span className="font-mono">{e.env.record_id}</span><HashChip value={e.env.content_hash} />{e.error ? <span className="text-danger">{e.error.replaceAll("_", " ")}</span> : null}</div>
                </li>))}
            </ol>)}</CardContent></Card>
      </div>
    </>
  );
}
