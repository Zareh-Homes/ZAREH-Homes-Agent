import { useState } from "react";
import { api } from "../app/api.ts";
import { useAction, useApi } from "../app/useApi.ts";
import { useSession } from "../app/session.tsx";
import { Button, Facts, Loading, Notice, Page, PageHeader, Section, Table, TextField } from "../ui/kit.tsx";
import { dateTimeText, ROLE_LABEL } from "../ui/format.ts";

interface SessionRow { id: string; createdAt: string; lastSeenAt: string; ip: string | null; userAgent: string | null; current: boolean }

export function AccountPage() {
  const { user } = useSession();
  const sessions = useApi<{ sessions: SessionRow[] }>("/api/auth/sessions");
  const revoke = useAction();
  const change = useAction();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [changed, setChanged] = useState(false);
  if (!user) return null;

  return (
    <Page>
      <PageHeader title="Your account" />
      <div className="grid gap-5 lg:grid-cols-2">
        <Section title="Profile">
          <Facts items={[
            ["Name", `${user.firstName} ${user.lastName}`], ["Email", user.email], ["Role", ROLE_LABEL[user.role] ?? user.role],
            ["Two-factor sign-in", user.mfa.enabled ? "On" : user.mfa.required ? "Required, not set up" : "Off"],
          ]} />
          <p className="mt-3 text-xs text-ink-3">An admin updates names, roles and PREC / HST details.</p>
        </Section>

        <Section title="Change password" description="Other devices are signed out when you change it.">
          {changed ? <Notice kind="success">Password changed.</Notice> : (
            <form
              className="space-y-3"
              onSubmit={async (e) => {
                e.preventDefault();
                const ok = await change.run(() => api("POST", "/api/auth/password", { currentPassword: current, newPassword: next }));
                if (ok) { setChanged(true); setCurrent(""); setNext(""); }
              }}
            >
              {change.error && <Notice kind="error">{change.error}</Notice>}
              <TextField label="Current password" type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
              <TextField label="New password" type="password" autoComplete="new-password" required hint="At least 12 characters" value={next}
                onChange={(e) => setNext(e.target.value)} error={change.fields.newPassword} />
              <Button type="submit" variant="primary" busy={change.busy} disabled={!current || next.length < 12}>Change password</Button>
            </form>
          )}
        </Section>

        <div className="lg:col-span-2">
          <Section title="Where you're signed in" description="Sign out a device you don't recognise.">
            {revoke.error && <div className="mb-3"><Notice kind="error">{revoke.error}</Notice></div>}
            {sessions.status === "loading" && !sessions.data ? <Loading /> : sessions.status === "error" ? <Notice kind="error">{sessions.message}</Notice> : (
              <Table head={["Device", "Signed in", "Last active", ""]}>
                {(sessions.data?.sessions ?? []).map((s) => (
                  <tr key={s.id}>
                    <td className="max-w-xs truncate" title={s.userAgent ?? ""}>{s.userAgent ?? "Unknown device"}{s.ip ? ` · ${s.ip}` : ""}{s.current && <span className="ml-2 text-xs font-medium text-good">This device</span>}</td>
                    <td>{dateTimeText(s.createdAt)}</td>
                    <td>{dateTimeText(s.lastSeenAt)}</td>
                    <td className="text-right">
                      {!s.current && (
                        <Button variant="ghost" busy={revoke.busy}
                          onClick={async () => { if (await revoke.run(() => api("POST", `/api/auth/sessions/${s.id}/revoke`))) sessions.reload(); }}>
                          Sign out
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </Table>
            )}
          </Section>
        </div>
      </div>
    </Page>
  );
}
