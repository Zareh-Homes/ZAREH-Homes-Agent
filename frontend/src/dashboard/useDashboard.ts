import { useCallback, useEffect, useState } from "react";
import type { DashboardResponse } from "./types.ts";

export type DashboardState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: DashboardResponse };

/** Loads the signed-in user's dashboard. The session cookie identifies them. */
export function useDashboard(fetcher: typeof fetch = fetch): { state: DashboardState; reload: () => void } {
  const [state, setState] = useState<DashboardState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState((s) => (s.status === "ready" ? s : { status: "loading" }));
    fetcher("/api/dashboard", { credentials: "include", signal: controller.signal })
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error(body?.error?.message ?? `The dashboard couldn't load (${res.status})`);
        setState({ status: "ready", data: body as DashboardResponse });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setState({ status: "error", message: err instanceof Error ? err.message : "The dashboard couldn't load" });
      });
    return () => controller.abort();
  }, [fetcher, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  return { state, reload };
}
