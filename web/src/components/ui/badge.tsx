import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badge = cva("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap", {
  variants: {
    tone: {
      neutral: "bg-muted text-muted-foreground",
      ok: "border-success/40 bg-success/10 text-success",
      warn: "border-warning/40 bg-warning/10 text-warning",
      danger: "border-danger/40 bg-danger/10 text-danger",
      info: "border-info/40 bg-info/10 text-info",
      brand: "border-primary/50 bg-primary/10 text-accent",
    },
  },
  defaultVariants: { tone: "neutral" },
});

export const Badge = ({ tone, className, ...p }: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badge>) => (
  <span className={cn(badge({ tone }), className)} {...p} />
);

const SEV: Record<string, "neutral" | "info" | "warn" | "danger"> = { low: "neutral", medium: "info", high: "warn", critical: "danger" };
export const SeverityBadge = ({ severity }: { severity: string }) => <Badge tone={SEV[severity] ?? "neutral"}>{severity}</Badge>;

const STATE: Record<string, "neutral" | "info" | "warn" | "danger" | "ok"> = {
  created: "neutral", uploading: "info", verifying: "info", verified: "ok", available: "ok", quarantined: "danger", expired: "warn",
  open: "danger", acknowledged: "ok", active: "ok", pending: "warn", released: "neutral",
};
export const StateBadge = ({ state }: { state: string }) => <Badge tone={STATE[state] ?? "neutral"}>{state}</Badge>;
