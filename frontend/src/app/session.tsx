/**
 * Who is signed in, and how far: signed out → password accepted → MFA (when the role requires it) → ready.
 * The server decides every permission; the role here only chooses which screens to offer.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, ApiError, SESSION_ENDED, setCsrfToken } from "./api.ts";

export type Role = "ADMIN" | "MANAGING_BROKER" | "COMPLIANCE_ADMIN" | "AGENT";

export interface Me {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: Role;
  mfa: { enabled: boolean; satisfied: boolean; required: boolean };
  csrfToken: string;
}

export type Phase = "loading" | "signedOut" | "mfaVerify" | "mfaEnrol" | "ready";

interface SessionValue {
  phase: Phase;
  user: Me | null;
  notice: string | null;
  refresh: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

const phaseFor = (me: Me): Phase =>
  me.mfa.required && !me.mfa.satisfied ? (me.mfa.enabled ? "mfaVerify" : "mfaEnrol") : "ready";

export function SessionProvider({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [user, setUser] = useState<Me | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const me = await api<Me>("GET", "/api/auth/me");
      setCsrfToken(me.csrfToken);
      setUser(me);
      setPhase(phaseFor(me));
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 401) setNotice(err instanceof Error ? err.message : null);
      setCsrfToken(null);
      setUser(null);
      setPhase("signedOut");
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    const ended = (e: Event) => {
      const err = (e as CustomEvent<ApiError>).detail;
      if (err.code === "MFA_REQUIRED" || err.code === "MFA_ENROLLMENT_REQUIRED") { void refresh(); return; }
      setNotice(err.code === "SESSION_EXPIRED" || err.code === "SESSION_IDLE" ? "Your session ended. Sign in again to continue." : err.message);
      setCsrfToken(null);
      setUser(null);
      setPhase("signedOut");
    };
    window.addEventListener(SESSION_ENDED, ended);
    return () => window.removeEventListener(SESSION_ENDED, ended);
  }, [refresh]);

  const signIn = useCallback(async (email: string, password: string) => {
    const res = await api<{ csrfToken: string }>("POST", "/api/auth/login", { email, password });
    setCsrfToken(res.csrfToken);
    setNotice(null);
    await refresh();
  }, [refresh]);

  const signOut = useCallback(async () => {
    try { await api("POST", "/api/auth/logout"); } catch { /* the session may already be gone */ }
    setCsrfToken(null);
    setUser(null);
    setNotice("You're signed out.");
    setPhase("signedOut");
    history.replaceState(null, "", "/");
  }, []);

  const value = useMemo(() => ({ phase, user, notice, refresh, signIn, signOut }), [phase, user, notice, refresh, signIn, signOut]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const v = useContext(SessionContext);
  if (!v) throw new Error("useSession outside SessionProvider");
  return v;
}

export const hasRole = (user: Me | null, roles: readonly Role[]) => !!user && roles.includes(user.role);
