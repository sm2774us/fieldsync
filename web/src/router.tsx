import { Outlet, createRootRoute, createRoute, createRouter, redirect, Link, type RouterHistory } from "@tanstack/react-router";
import { AppShell } from "@/components/layout/AppShell";
import { ErrorBoundary } from "@/components/layout/ErrorBoundary";
import { Button } from "@/components/ui/button";
import { AlertsPage } from "@/pages/AlertsPage";
import { AuditPage } from "@/pages/AuditPage";
import { DashboardPage } from "@/pages/DashboardPage";
import { DevicesPage } from "@/pages/DevicesPage";
import { FieldPage } from "@/pages/FieldPage";
import { DeviceDetailPage, FleetPage } from "@/pages/FleetPage";
import { RecordDetailPage, RecordsPage } from "@/pages/RecordsPage";
import { ConflictsPage, QuarantinePage } from "@/pages/ReviewPages";
import { LoginPage } from "@/pages/LoginPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { useSession } from "@/store/session";

const root = createRootRoute({
  component: () => <ErrorBoundary><Outlet /></ErrorBoundary>,
  notFoundComponent: () => (
    <div className="grid h-full place-items-center p-8 text-center"><div><h1 className="text-xl font-semibold">Page not found</h1><Button asChild className="mt-4"><Link to="/">Back to dashboard</Link></Button></div></div>
  ),
});

const login = createRoute({ getParentRoute: () => root, path: "/login", component: LoginPage });

const authed = createRoute({
  getParentRoute: () => root, id: "authed", component: AppShell,
  beforeLoad: () => { if (!useSession.getState().token) throw redirect({ to: "/login" }); },
});

const r = (path: string, component: () => React.JSX.Element) => createRoute({ getParentRoute: () => authed, path, component });
const search = (s: Record<string, unknown>) => ({ tab: typeof s.tab === "string" ? s.tab : undefined, q: typeof s.q === "string" ? s.q : undefined });

const tree = root.addChildren([
  login,
  authed.addChildren([
    createRoute({ getParentRoute: () => authed, path: "/", component: DashboardPage }),
    r("/field", () => <FieldPage />),
    r("/fleet", FleetPage),
    createRoute({ getParentRoute: () => authed, path: "/fleet/$id", component: DeviceDetailPage, validateSearch: search }),
    r("/records", RecordsPage),
    r("/records/$id", RecordDetailPage),
    r("/conflicts", ConflictsPage),
    r("/quarantine", QuarantinePage),
    r("/alerts", AlertsPage),
    r("/audit", AuditPage),
    r("/devices", DevicesPage),
    r("/settings", SettingsPage),
  ]),
]);

export const buildRouter = (history?: RouterHistory) => createRouter({ routeTree: tree, defaultPreload: "intent", history });
export const router = buildRouter();
declare module "@tanstack/react-router" { interface Register { router: typeof router } }
