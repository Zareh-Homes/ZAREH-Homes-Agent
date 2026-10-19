/**
 * The app: who's signed in decides what renders. Before sign-in only the
 * sign-in, two-factor, invitation and reset screens exist; after it, each
 * route checks the role the server reported. The server enforces the same
 * rules on every request, so hiding a screen here is only for clarity.
 */

import type { ReactNode } from "react";
import { hasRole, SessionProvider, useSession, type Role } from "./session.tsx";
import { Routes, useLocation, type Route } from "./router.tsx";
import { Shell } from "./Shell.tsx";
import { Loading, Notice, Page, ButtonLink } from "../ui/kit.tsx";
import { MfaEnrol, MfaVerify, SetPassword, SignIn } from "../auth/AuthScreens.tsx";
import { AccountPage } from "../auth/AccountPage.tsx";
import { DashboardPage } from "../dashboard/components/Dashboard.tsx";
import { useDashboard } from "../dashboard/useDashboard.ts";
import { PipelinePage } from "../pipeline/components/PipelineBoard.tsx";
import { usePipeline } from "../pipeline/usePipeline.ts";
import { LiveOversight } from "../oversight/OversightPanel.tsx";
import { DealsList } from "../deals/DealsList.tsx";
import { NewDeal } from "../deals/NewDeal.tsx";
import { DealWorkspace } from "../deals/DealWorkspace.tsx";
import { TradeRecordPrint } from "../deals/TradeRecordPrint.tsx";
import { TrustPage } from "../trust/TrustPage.tsx";
import { BankPage } from "../bank/BankPage.tsx";
import { ComplianceReviewPage } from "../review/ComplianceReviewPage.tsx";
import { ApprovalsPage } from "../work/ApprovalsPage.tsx";
import { AdminPage } from "../admin/AdminPage.tsx";

const STAFF: Role[] = ["ADMIN", "MANAGING_BROKER", "COMPLIANCE_ADMIN"];
const BANK: Role[] = ["ADMIN", "MANAGING_BROKER"];
const REVIEWERS: Role[] = ["MANAGING_BROKER", "COMPLIANCE_ADMIN", "ADMIN"];

function LiveDashboard() {
  const { state, reload } = useDashboard();
  return <DashboardPage state={state} onRetry={reload} />;
}

function LivePipeline({ q }: { q: string }) {
  const { state, reload } = usePipeline();
  return <PipelinePage state={state} onRetry={reload} initialQuery={q} />;
}

function Forbidden() {
  return (
    <Page>
      <Notice kind="warning" title="Your role doesn't include this page">Ask the broker of record if you need access.</Notice>
      <div className="mt-4"><ButtonLink href="/">Back to the dashboard</ButtonLink></div>
    </Page>
  );
}

function NotFound() {
  return (
    <Page>
      <Notice kind="info" title="Nothing here">The link may be out of date.</Notice>
      <div className="mt-4"><ButtonLink href="/">Back to the dashboard</ButtonLink></div>
    </Page>
  );
}

function Gate({ roles, children }: { roles: Role[]; children: ReactNode }) {
  const { user } = useSession();
  return hasRole(user, roles) ? <>{children}</> : <Forbidden />;
}

const ROUTES: Route[] = [
  { path: "/", render: () => <LiveDashboard /> },
  { path: "/pipeline", render: (_, s) => <LivePipeline q={s.get("q") ?? ""} /> },
  { path: "/deals", render: () => <DealsList /> },
  { path: "/deals/new", render: () => <NewDeal /> },
  { path: "/deals/:id/trade-record/print", render: (p) => <TradeRecordPrint dealId={p.id!} /> },
  { path: "/deals/:id", render: (p) => <DealWorkspace dealId={p.id!} tab="overview" /> },
  { path: "/deals/:id/:tab", render: (p) => <DealWorkspace dealId={p.id!} tab={p.tab!} /> },
  { path: "/compliance", render: () => <Gate roles={REVIEWERS}><ComplianceReviewPage tab="documents" /></Gate> },
  { path: "/compliance/:tab", render: (p) => <Gate roles={REVIEWERS}><ComplianceReviewPage tab={p.tab!} /></Gate> },
  { path: "/trust", render: () => <Gate roles={STAFF}><TrustPage tab="status" /></Gate> },
  { path: "/trust/:tab", render: (p) => <Gate roles={STAFF}><TrustPage tab={p.tab!} /></Gate> },
  { path: "/trust/incidents/:id", render: (p) => <Gate roles={STAFF}><TrustPage tab="incidents" id={p.id} /></Gate> },
  { path: "/bank", render: () => <Gate roles={BANK}><BankPage tab="statements" /></Gate> },
  { path: "/bank/reconciliations", render: () => <Gate roles={BANK}><BankPage tab="reconciliations" /></Gate> },
  { path: "/bank/funds", render: () => <Gate roles={BANK}><BankPage tab="funds" /></Gate> },
  { path: "/bank/statements/:id", render: (p) => <Gate roles={BANK}><BankPage tab="statements" id={p.id} /></Gate> },
  { path: "/bank/reconciliations/:id", render: (p) => <Gate roles={BANK}><BankPage tab="reconciliations" id={p.id} /></Gate> },
  { path: "/approvals", render: () => <Gate roles={BANK}><ApprovalsPage /></Gate> },
  { path: "/admin", render: () => <Gate roles={BANK}><AdminPage tab="people" /></Gate> },
  { path: "/admin/:tab", render: (p) => <Gate roles={BANK}><AdminPage tab={p.tab!} /></Gate> },
  { path: "/oversight/broker", render: () => <Gate roles={STAFF}><LiveOversight view="broker" /></Gate> },
  { path: "/oversight/accounting", render: () => <Gate roles={STAFF}><LiveOversight view="accounting" /></Gate> },
  { path: "/oversight/me", render: () => <LiveOversight view="agent" /> },
  { path: "/account", render: () => <AccountPage /> },
];

function Screens() {
  const { phase } = useSession();
  const loc = useLocation();
  // Links from invitation and reset emails work whether or not someone is signed in.
  if (loc.path === "/accept-invite") return <SetPassword purpose="invite" />;
  if (loc.path === "/reset-password") return <SetPassword purpose="reset" />;
  if (phase === "loading") return <div className="flex min-h-dvh items-center justify-center bg-page"><Loading label="Checking your session" /></div>;
  if (phase === "signedOut") return <SignIn />;
  if (phase === "mfaVerify") return <MfaVerify />;
  if (phase === "mfaEnrol") return <MfaEnrol />;
  if (loc.path.endsWith("/trade-record/print")) return <Routes routes={ROUTES} fallback={<NotFound />} />;
  return <Shell><Routes routes={ROUTES} fallback={<NotFound />} /></Shell>;
}

export function App() {
  return <SessionProvider><Screens /></SessionProvider>;
}
