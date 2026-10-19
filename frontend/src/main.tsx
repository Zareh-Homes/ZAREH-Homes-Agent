import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./app/App.tsx";

const params = new URLSearchParams(location.search);
const theme = params.get("theme");
if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;

/**
 * Demo screens with invented figures, for design work only. They exist in a
 * development build or one built with VITE_ENABLE_DEMO=true, never otherwise,
 * and they bypass nothing: no API call is made and no session is created.
 */
async function demoScreen(): Promise<ReactNode | null> {
  const key = params.get("demo");
  if (!key || !(import.meta.env.DEV || import.meta.env.VITE_ENABLE_DEMO === "true")) return null;
  const route = location.pathname.replace(/\/+$/, "") || "/";
  let screen: ReactNode = null;
  if (route === "/pipeline") {
    const [{ demoPipeline }, { PipelineBoard }] = await Promise.all([import("./pipeline/demo-data.ts"), import("./pipeline/components/PipelineBoard.tsx")]);
    screen = <PipelineBoard data={demoPipeline} initialQuery={params.get("q") ?? ""} />;
  } else {
    const [{ demoResponses }, { Dashboard }] = await Promise.all([import("./dashboard/demo-data.ts"), import("./dashboard/components/Dashboard.tsx")]);
    const data = demoResponses[key];
    if (data) screen = <Dashboard data={data} />;
  }
  if (!screen) return null;
  return (
    <>
      <p className="bg-warning/20 px-4 py-1.5 text-center text-xs font-medium text-ink">Demo data — not real figures</p>
      {screen}
    </>
  );
}

void demoScreen().then((demo) => {
  createRoot(document.getElementById("root")!).render(<StrictMode>{demo ?? <App />}</StrictMode>);
});
