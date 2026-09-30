import { useQuery } from "@tanstack/react-query";
import { useSession, usePrefs, type Theme } from "@/store/session";
import { api } from "@/lib/api";
import { PERMISSIONS, secondsLeft } from "@/lib/auth";
import { fmtCountdown, fmtTime } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { HashChip, PageHeader } from "@/components/ui/misc";

export function SettingsPage() {
  const id = useSession((s) => s.identity)!;
  const { theme, setTheme, clear, recents } = usePrefs();
  const key = useQuery({ queryKey: ["keys"], queryFn: api.keys, staleTime: 600_000 });
  return (
    <>
      <PageHeader title="Settings" subtitle="Session, appearance and service trust anchor." />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card><CardHeader><CardTitle>Session</CardTitle><Badge tone="brand">{id.role}</Badge></CardHeader><CardContent className="space-y-1.5 text-sm">
          <div className="flex justify-between"><span className="text-muted-foreground">Identity</span><span>{id.sub}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Agency</span><span>{id.agency}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Expires</span><span>{fmtTime(id.exp * 1000)} ({fmtCountdown(secondsLeft(id))})</span></div>
          <div className="pt-2 text-xs text-muted-foreground">Permissions</div>
          <div className="flex flex-wrap gap-1">{PERMISSIONS[id.role].map((p) => <Badge key={p}>{p}</Badge>)}</div>
        </CardContent></Card>
        <Card><CardHeader><CardTitle>Appearance</CardTitle></CardHeader><CardContent className="space-y-3">
          <div className="flex gap-2" role="radiogroup" aria-label="Theme">{(["dark", "light", "system"] as Theme[]).map((t) => <Button key={t} role="radio" aria-checked={theme === t} variant={theme === t ? "primary" : "outline"} size="sm" onClick={() => setTheme(t)}>{t}</Button>)}</div>
          <Button variant="outline" size="sm" onClick={clear} disabled={!recents.length}>Clear recent items ({recents.length})</Button>
        </CardContent></Card>
        <Card className="lg:col-span-2"><CardHeader><CardTitle>Service trust anchor</CardTitle></CardHeader><CardContent className="space-y-2 text-sm">
          <p className="text-muted-foreground">Receipts, custody reports and audit checkpoints are signed with this Ed25519 key. Compare it with the key your administrator published out-of-band.</p>
          {key.data ? <><div className="flex justify-between"><span className="text-muted-foreground">Key ID</span><span className="font-mono">{key.data.key_id}</span></div>
            <div className="flex items-center justify-between"><span className="text-muted-foreground">Public key</span><HashChip value={key.data.public_key} full /></div></> : <p>{key.isError ? "Unavailable" : "Loading…"}</p>}
        </CardContent></Card>
      </div>
    </>
  );
}
