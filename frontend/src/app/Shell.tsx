/**
 * The signed-in frame: brand, the sections this person's role can use,
 * their name and sign-out. On phones the sections fold into a menu.
 */

import { useEffect, useState, type ReactNode } from "react";
import { Link, useLocation } from "./router.tsx";
import { useSession, type Role } from "./session.tsx";
import { ROLE_LABEL } from "../ui/format.ts";

interface NavItem { href: string; label: string; roles: Role[]; match?: string }

const STAFF: Role[] = ["ADMIN", "MANAGING_BROKER", "COMPLIANCE_ADMIN"];
const ALL: Role[] = ["ADMIN", "MANAGING_BROKER", "COMPLIANCE_ADMIN", "AGENT"];

export const NAV: NavItem[] = [
  { href: "/", label: "Dashboard", roles: ALL },
  { href: "/deals", label: "Deals", roles: ALL, match: "/deals" },
  { href: "/pipeline", label: "Pipeline", roles: ALL },
  { href: "/compliance", label: "Compliance review", roles: ["COMPLIANCE_ADMIN", "MANAGING_BROKER", "ADMIN"], match: "/compliance" },
  { href: "/trust", label: "Trust", roles: ["MANAGING_BROKER", "ADMIN", "COMPLIANCE_ADMIN"], match: "/trust" },
  { href: "/bank", label: "Bank & reconciliation", roles: ["MANAGING_BROKER", "ADMIN"], match: "/bank" },
  { href: "/approvals", label: "Approvals & payouts", roles: ["MANAGING_BROKER", "ADMIN"], match: "/approvals" },
  { href: "/oversight/broker", label: "Oversight", roles: STAFF, match: "/oversight" },
  { href: "/oversight/me", label: "My compliance", roles: ["AGENT"] },
  { href: "/admin", label: "Admin", roles: ["ADMIN", "MANAGING_BROKER"], match: "/admin" },
];

export function navFor(role: Role) {
  return NAV.filter((n) => n.roles.includes(role));
}

export function Shell({ children }: { children: ReactNode }) {
  const { user, signOut } = useSession();
  const loc = useLocation();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [loc.path]);
  if (!user) return <>{children}</>;
  const items = navFor(user.role);
  const active = (n: NavItem) => (n.match ? loc.path === n.match || loc.path.startsWith(`${n.match}/`) : loc.path === n.href);

  const links = (stacked: boolean) => items.map((n) => (
    <li key={n.href}>
      <Link
        href={n.href}
        aria-current={active(n) ? "page" : undefined}
        className={stacked
          ? `block rounded-lg px-3 py-2.5 text-sm font-medium ${active(n) ? "bg-sunken text-ink" : "text-ink-2 hover:bg-sunken hover:text-ink"}`
          : `block whitespace-nowrap border-b-2 px-2 py-3.5 text-sm font-medium ${active(n) ? "border-accent text-ink" : "border-transparent text-ink-2 hover:text-ink"}`}
      >
        {n.label}
      </Link>
    </li>
  ));

  return (
    <div className="min-h-dvh bg-page">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-card focus:px-3 focus:py-2">
        Skip to content
      </a>
      <header className="sticky top-0 z-30 border-b border-line bg-card/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1600px] items-center gap-4 px-4 sm:px-6 lg:px-8">
          <Link href="/" className="py-3 text-sm font-semibold tracking-tight text-ink">Zareh Homes · Back Office</Link>
          <nav aria-label="Main" className="hidden min-w-0 flex-1 overflow-x-auto xl:block">
            <ul className="flex gap-1">{links(false)}</ul>
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <span className="hidden text-right text-xs leading-tight text-ink-2 sm:block xl:hidden 2xl:block">
              <span className="block font-medium text-ink">{user.firstName} {user.lastName}</span>
              {ROLE_LABEL[user.role] ?? user.role}
            </span>
            <Link href="/account" className="hidden rounded-lg px-2 py-1.5 text-sm text-ink-2 hover:bg-sunken hover:text-ink sm:block">Account</Link>
            <button type="button" onClick={() => void signOut()} className="rounded-lg px-2 py-1.5 text-sm font-medium text-ink-2 hover:bg-sunken hover:text-ink">
              Sign out
            </button>
            <button
              type="button"
              className="rounded-lg border border-line px-2.5 py-1.5 text-sm font-medium text-ink xl:hidden"
              aria-expanded={open}
              aria-controls="mobile-nav"
              onClick={() => setOpen((v) => !v)}
            >
              Menu
            </button>
          </div>
        </div>
        {open && (
          <nav id="mobile-nav" aria-label="Main" className="border-t border-line px-4 py-2 xl:hidden">
            <ul className="grid gap-1 sm:grid-cols-2">
              {links(true)}
              <li><Link href="/account" className="block rounded-lg px-3 py-2.5 text-sm font-medium text-ink-2 hover:bg-sunken">Account</Link></li>
            </ul>
          </nav>
        )}
      </header>
      <main id="main">{children}</main>
    </div>
  );
}
