import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { KeyRound, ShieldCheck, WifiOff } from "lucide-react";
import * as React from "react";
import { api } from "@/lib/api";
import { PERMISSIONS, decodeToken } from "@/lib/auth";
import { fmtTime } from "@/lib/utils";
import { useSession } from "@/store/session";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/input";

export function LoginPage() {
  const signIn = useSession((s) => s.signIn);
  const notice = useSession((s) => s.notice);
  const nav = useNavigate();
  const [token, setToken] = React.useState("");
  const [err, setErr] = React.useState<string | null>(null);
  const ready = useQuery({ queryKey: ["ready"], queryFn: api.ready, retry: false });
  const preview = token.trim() ? decodeToken(token) : null;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    try { signIn(token); setErr(null); void nav({ to: "/" }); }
    catch (x) { setErr(x instanceof Error ? x.message : "Sign-in failed"); }
  };

  return (
    <div className="grid min-h-full place-items-center p-4">
      <div className="w-full max-w-lg space-y-4">
        <div className="flex items-center gap-3">
          <span className="grid size-11 place-items-center rounded-xl bg-primary text-primary-foreground"><ShieldCheck className="size-6" /></span>
          <div><h1 className="text-2xl font-semibold tracking-tight">FieldSync Console</h1><p className="text-sm text-muted-foreground">Operate a fleet of offline-capable devices with a trustworthy record</p></div>
        </div>
        <Card>
          <CardContent>
            <form onSubmit={submit} className="space-y-4" noValidate>
              <div>
                <label htmlFor="token" className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><KeyRound className="size-3.5" /> Access token</label>
                <Textarea id="token" autoFocus spellCheck={false} autoComplete="off" rows={4} className="font-mono text-xs" placeholder="Paste the token issued for you by your agency administrator"
                  value={token} onChange={(e) => setToken(e.target.value)} aria-invalid={!!err} aria-describedby="token-help" />
                <p id="token-help" className="mt-1.5 text-xs text-muted-foreground">Held in this tab only. It is discarded when you close the tab or sign out.</p>
              </div>
              {preview ? (
                <div className="flex flex-wrap items-center gap-2 rounded-lg bg-muted p-3 text-sm">
                  <Badge tone="brand">{preview.role}</Badge><span>{preview.sub}</span><span className="text-muted-foreground">@ {preview.agency}</span>
                  <span className="ml-auto text-xs text-muted-foreground">expires {fmtTime(preview.exp * 1000)}</span>
                  <p className="w-full text-xs text-muted-foreground">Can: {PERMISSIONS[preview.role].join(", ")}</p>
                </div>
              ) : null}
              {notice ? <p role="status" className="text-sm text-warning">{notice}</p> : null}
              {err ? <p role="alert" className="text-sm text-danger">{err}</p> : null}
              <Button type="submit" size="lg" className="w-full" disabled={!token.trim()}>Sign in</Button>
            </form>
          </CardContent>
        </Card>
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          {ready.isError ? <><WifiOff className="size-3.5 text-warning" /> Service unreachable. Check with your administrator.</>
            : ready.data ? <><ShieldCheck className={`size-3.5 ${ready.data.ready ? "text-success" : "text-danger"}`} /> Service {ready.data.ready ? "online, audit chain intact" : "reports an audit integrity failure"}</> : "Checking service…"}
        </p>
      </div>
    </div>
  );
}
