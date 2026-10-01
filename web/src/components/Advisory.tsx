import { useMutation } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { api } from "@/lib/api";
import { can } from "@/lib/auth";
import { useSession } from "@/store/session";
import { Badge, SeverityBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/misc";

const ACTIONS: Record<string, string> = {
  retain_for_investigation: "Keep everything as received", request_device_resend: "Ask the device to resend the original",
  inspect_device_integrity: "Inspect the device", notify_security_officer: "Notify a security officer",
  revoke_device_credentials: "Revoke the device", update_device_app: "Update the device app",
  free_device_storage: "Free device storage", contact_device_operator: "Contact the device operator",
  compare_record_versions: "Compare the record versions", no_action: "No action needed",
};

/** Advisory only. Rules decide; an optional model may add detail. Nothing here changes any data. */
export function AdvisoryPanel({ kind, id }: { kind: "quarantine" | "conflicts" | "alerts"; id: string }) {
  const role = useSession((s) => s.identity?.role);
  const m = useMutation({ mutationFn: () => api.triage(kind, id) });
  if (!can(role, "triage:run")) return null;
  const a = m.data;
  return (
    <section aria-label="Advisory" className="rounded-lg border border-dashed p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" loading={m.isPending} onClick={() => m.mutate()}><Sparkles className="size-3.5" /> {a ? "Refresh advisory" : "Get advisory"}</Button>
        <span className="text-xs text-muted-foreground">Advice only. It never decides, and it is recorded in the audit log.</span>
      </div>
      {m.isError ? <div className="mt-2"><ErrorState error={m.error} /></div> : null}
      {a ? (
        <div className="mt-3 space-y-2" role="status">
          <div className="flex flex-wrap items-center gap-2"><SeverityBadge severity={a.severity} /><Badge>{a.category.replaceAll("_", " ")}</Badge>
            <Badge tone={a.source === "rules" ? "neutral" : "info"}>{a.source === "rules" ? "rules" : `rules + AI (${a.model})`}</Badge></div>
          <p>{a.summary}</p>
          <ul className="list-disc pl-5 text-muted-foreground">{a.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
          <div className="text-xs text-muted-foreground">Suggested next steps</div>
          <ul className="list-disc pl-5">{a.recommended_actions.map((x) => <li key={x}>{ACTIONS[x] ?? x}</li>)}</ul>
        </div>) : null}
    </section>
  );
}
