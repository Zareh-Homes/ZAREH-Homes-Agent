import { useCallback, useEffect, useState } from "react";
import type { PipelineResponse } from "./types.ts";

export type PipelineState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: PipelineResponse };

/** Loads the board; reloads every 2 minutes while the tab is visible so badges stay current. */
export function usePipeline(fetcher: typeof fetch = fetch, refreshMs = 120_000): { state: PipelineState; reload: () => void } {
  const [state, setState] = useState<PipelineState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    fetcher("/api/pipeline", { credentials: "include", signal: controller.signal })
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error(body?.error?.message ?? `The pipeline couldn't load (${res.status})`);
        setState({ status: "ready", data: body as PipelineResponse });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        // Keep showing the last good board if a background refresh fails
        setState((s) => (s.status === "ready" ? s : { status: "error", message: err instanceof Error ? err.message : "The pipeline couldn't load" }));
      });
    return () => controller.abort();
  }, [fetcher, attempt]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") setAttempt((n) => n + 1);
    }, refreshMs);
    return () => clearInterval(timer);
  }, [refreshMs]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  return { state, reload };
}
