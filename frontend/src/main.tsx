import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { Dashboard, DashboardPage } from "./dashboard/components/Dashboard.tsx";
import { useDashboard } from "./dashboard/useDashboard.ts";

function LiveDashboard() {
  const { state, reload } = useDashboard();
  return <DashboardPage state={state} onRetry={reload} />;
}

async function boot() {
  const params = new URLSearchParams(location.search);
  const theme = params.get("theme");
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;

  const demoKey = params.get("demo");
  const demoAllowed = import.meta.env.DEV || import.meta.env.VITE_ENABLE_DEMO === "true";
  let app = <LiveDashboard />;
  if (demoKey && demoAllowed) {
    const { demoResponses } = await import("./dashboard/demo-data.ts");
    const data = demoResponses[demoKey];
    if (data) {
      app = (
        <>
          <p className="bg-warning/20 px-4 py-1.5 text-center text-xs font-medium text-ink">Demo data — not real figures</p>
          <Dashboard data={data} />
        </>
      );
    }
  }
  createRoot(document.getElementById("root")!).render(<StrictMode>{app}</StrictMode>);
}

void boot();
