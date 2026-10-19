import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, errorMessage } from "./api.ts";

export type Loadable<T> =
  | { status: "loading"; data?: T }
  | { status: "error"; error: ApiError | Error; message: string; data?: T }
  | { status: "ready"; data: T };

/** GET a resource; reload() refetches and keeps showing the old data meanwhile. */
export function useApi<T>(path: string | null): Loadable<T> & { reload: () => void } {
  const [state, setState] = useState<Loadable<T>>({ status: "loading" });
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    setState((s) => ({ status: "loading", data: s.data }));
    api<T>("GET", path, undefined, { signal: controller.signal })
      .then((data) => setState({ status: "ready", data }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setState((s) => ({ status: "error", error: err as Error, message: errorMessage(err), data: s.data }));
      });
    return () => controller.abort();
  }, [path, n]);
  const reload = useCallback(() => setN((x) => x + 1), []);
  return { ...state, reload };
}

/**
 * Runs one action (a POST) with busy/error state. Returns the result, or
 * undefined when it failed (the error is in `error`, field issues in `fields`).
 */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<ApiError | null>(null);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    setFields({});
    setFailure(null);
    try {
      return await fn();
    } catch (err) {
      if (!mounted.current) return undefined;
      setError(errorMessage(err));
      if (err instanceof ApiError) { setFields(err.fieldErrors); setFailure(err); }
      return undefined;
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, []);
  const clear = useCallback(() => { setError(null); setFields({}); setFailure(null); }, []);
  /** failure: the server's error itself, for screens that show its code or details */
  return { busy, error, fields, failure, run, clear };
}
