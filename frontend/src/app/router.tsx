/**
 * A small client-side router: path patterns with :params, links that don't
 * reload the page, and back/forward support. No dependency; the app only
 * needs exact paths and parameters.
 */

import { useEffect, useState, type AnchorHTMLAttributes, type MouseEvent, type ReactNode } from "react";

const CHANGE = "app:navigate";

export interface Location {
  path: string;
  search: URLSearchParams;
}

const current = (): Location => ({ path: location.pathname.replace(/\/+$/, "") || "/", search: new URLSearchParams(location.search) });

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  if (opts.replace) history.replaceState(null, "", to);
  else history.pushState(null, "", to);
  window.dispatchEvent(new Event(CHANGE));
  window.scrollTo({ top: 0 });
}

export function useLocation(): Location {
  const [loc, setLoc] = useState(current);
  useEffect(() => {
    const update = () => setLoc(current());
    window.addEventListener("popstate", update);
    window.addEventListener(CHANGE, update);
    return () => {
      window.removeEventListener("popstate", update);
      window.removeEventListener(CHANGE, update);
    };
  }, []);
  return loc;
}

/** "/deals/:id/documents" against "/deals/abc/documents" → { id: "abc" }, or null */
export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split("/").filter(Boolean);
  const s = path.split("/").filter(Boolean);
  if (p.length !== s.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i]!.startsWith(":")) params[p[i]!.slice(1)] = decodeURIComponent(s[i]!);
    else if (p[i] !== s[i]) return null;
  }
  return params;
}

export interface Route {
  path: string;
  render: (params: Record<string, string>, search: URLSearchParams) => ReactNode;
}

export function Routes({ routes, fallback }: { routes: Route[]; fallback: ReactNode }) {
  const loc = useLocation();
  for (const r of routes) {
    const params = matchPath(r.path, loc.path);
    if (params) return <>{r.render(params, loc.search)}</>;
  }
  return <>{fallback}</>;
}

/** An <a> that navigates in-app; modified clicks (new tab, etc.) behave normally. */
export function Link({ href, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const handle = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || rest.target === "_blank") return;
    if (!href.startsWith("/")) return;
    e.preventDefault();
    navigate(href);
  };
  return <a href={href} onClick={handle} {...rest} />;
}
