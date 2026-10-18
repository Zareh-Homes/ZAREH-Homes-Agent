import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { AppNav } from "./app/AppNav.tsx";
import { Dashboard, DashboardPage } from "./dashboard/components/Dashboard.tsx";
import { useDashboard } from "./dashboard/useDashboard.ts";
import { PipelineBoard, PipelinePage } from "./pipeline/components/PipelineBoard.tsx";
import { usePipeline } from "./pipeline/usePipeline.ts";

function LiveDashboard() {
  const { state, reload } = useDashboard();
  return <DashboardPage state={state} onRetry={reload} />;
}

// ?q= pre-fills the search, so a filtered board can be shared as a link
const initialQuery = new URLSearchParams(location.search).get("q") ?? "";

function LivePipeline() {
  const { state, reload } = usePipeline();
  return <PipelinePage state={state} onRetry={reload} initialQuery={initialQuery} />;
}

async function demoScreen(route: string, key: string): Promise<ReactNode | null> {
  if (route === "/pipeline") {
    const { demoPipeline } = await import("./pipeline/demo-data.ts");
    return <PipelineBoard data={demoPipeline} initialQuery={initialQuery} />;
  }
  const { demoResponses } = await import("./dashboard/demo-data.ts");
  const data = demoResponses[key];
  return data ? <Dashboard data={data} /> : null;
}

async function boot() {
  const params = new URLSearchParams(location.search);
  const theme = params.get("theme");
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;

  const route = location.pathname.replace(/\/+$/, "") || "/";
  let screen: ReactNode = route === "/pipeline" ? <LivePipeline /> : <LiveDashboard />;

  const demoKey = params.get("demo");
  const demoAllowed = import.meta.env.DEV || import.meta.env.VITE_ENABLE_DEMO === "true";
  if (demoKey && demoAllowed) {
    const demo = await demoScreen(route, demoKey);
    if (demo) {
      screen = (
        <>
          <p className="bg-warning/20 px-4 py-1.5 text-center text-xs font-medium text-ink">Demo data — not real figures</p>
          {demo}
        </>
      );
    }
  }

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <AppNav current={route} />
      {screen}
    </StrictMode>,
  );
}

void boot();
