import { Bell, Cpu, FileText, GitCompareArrows, LayoutDashboard, Radio, ScrollText, Settings, ShieldQuestion, Smartphone } from "lucide-react";
import { can } from "@/lib/auth";

export const NAV = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, perm: null },
  { to: "/field", label: "Field app", icon: Smartphone, perm: "sync:write" },
  { to: "/fleet", label: "Fleet", icon: Radio, perm: "fleet:read" },
  { to: "/records", label: "Records", icon: FileText, perm: "records:read" },
  { to: "/conflicts", label: "Conflicts", icon: GitCompareArrows, perm: "conflicts:read" },
  { to: "/quarantine", label: "Quarantine", icon: ShieldQuestion, perm: "quarantine:read" },
  { to: "/alerts", label: "Alerts", icon: Bell, perm: "alerts:read" },
  { to: "/audit", label: "Audit log", icon: ScrollText, perm: "audit:read" },
  { to: "/devices", label: "Enrolment", icon: Cpu, perm: "device:register" },
  { to: "/settings", label: "Settings", icon: Settings, perm: null },
] as const;

export const allowed = (role: Parameters<typeof can>[0], perm: string | null) => !perm || perm.split("|").some((p) => can(role, p));

