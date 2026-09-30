import { AlertTriangle, Check, Copy, RefreshCw } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { ApiError } from "@/lib/api";
import { cn, shortHash } from "@/lib/utils";
import { Button } from "./button";

export const Skeleton = ({ className }: { className?: string }) => (
  <div aria-hidden className={cn("relative overflow-hidden rounded-md bg-muted", className)}>
    <div className="absolute inset-0 -translate-x-full animate-[shimmer_1.6s_infinite] bg-gradient-to-r from-transparent via-foreground/5 to-transparent" />
  </div>
);

export function HashChip({ value, full = false }: { value: string | null | undefined; full?: boolean }) {
  const [done, setDone] = React.useState(false);
  if (!value) return <span className="text-muted-foreground">—</span>;
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); setDone(true); setTimeout(() => setDone(false), 1500); }
    catch { toast.error("Copy failed. Select the text manually."); }
  };
  return (
    <button type="button" onClick={copy} title={value} aria-label={`Copy ${value}`}
      className="inline-flex max-w-full items-center gap-1.5 rounded-md bg-muted px-2 py-0.5 font-mono text-xs hover:bg-border">
      <span className={cn(full ? "break-all text-left" : "truncate")}>{full ? value : shortHash(value)}</span>
      {done ? <Check className="size-3 shrink-0 text-success" /> : <Copy className="size-3 shrink-0 opacity-60" />}
    </button>
  );
}

export function ErrorState({ error, onRetry, className }: { error: unknown; onRetry?: () => void; className?: string }) {
  const e = error instanceof ApiError ? error : null;
  const forbidden = e?.status === 403;
  return (
    <div role="alert" className={cn("flex flex-col items-start gap-3 rounded-lg border border-danger/40 bg-danger/5 p-4", className)}>
      <div className="flex items-center gap-2 font-medium text-danger">
        <AlertTriangle className="size-4" />
        {forbidden ? "Not permitted" : e?.status === 404 ? "Not found" : e?.retryable ? "Service problem" : "Request failed"}
      </div>
      <p className="text-sm">{e?.message ?? (error instanceof Error ? error.message : "Something went wrong.")}</p>
      {forbidden ? <p className="text-xs text-muted-foreground">Your role does not allow this action. The attempt has been recorded in the audit log.</p> : null}
      {e?.requestId ? <p className="font-mono text-xs text-muted-foreground">request-id {e.requestId}</p> : null}
      {onRetry && !forbidden ? <Button size="sm" variant="outline" onClick={onRetry}><RefreshCw className="size-3.5" /> Try again</Button> : null}
    </div>
  );
}

export const EmptyState = ({ icon, title, hint }: { icon?: React.ReactNode; title: string; hint?: string }) => (
  <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-muted-foreground">
    {icon}
    <p className="font-medium text-foreground">{title}</p>
    {hint ? <p className="max-w-sm text-sm">{hint}</p> : null}
  </div>
);

/** Two-step confirm for mutating actions: first click arms it, second click within 5s commits. */
export function ConfirmButton({ label, confirmLabel = "Confirm", onConfirm, variant = "outline", size = "sm", disabled, loading }: {
  label: React.ReactNode; confirmLabel?: string; onConfirm: () => void; variant?: "outline" | "danger" | "primary" | "secondary";
  size?: "sm" | "md"; disabled?: boolean; loading?: boolean;
}) {
  const [armed, setArmed] = React.useState(false);
  React.useEffect(() => { if (!armed) return; const t = setTimeout(() => setArmed(false), 5000); return () => clearTimeout(t); }, [armed]);
  return (
    <Button size={size} variant={armed ? "danger" : variant} disabled={disabled} loading={loading}
      onClick={() => { if (armed) { setArmed(false); onConfirm(); } else setArmed(true); }}>
      {armed ? confirmLabel : label}
    </Button>
  );
}

export const Kbd = ({ children }: { children: React.ReactNode }) => (
  <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">{children}</kbd>
);

export const PageHeader = ({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: React.ReactNode }) => (
  <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
    <div>
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      {subtitle ? <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p> : null}
    </div>
    {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
  </div>
);

export const Field = ({ label, htmlFor, children, hint }: { label: string; htmlFor: string; children: React.ReactNode; hint?: string }) => (
  <div>
    <label htmlFor={htmlFor} className="mb-1.5 block text-xs font-medium text-muted-foreground">{label}</label>
    {children}
    {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
  </div>
);
