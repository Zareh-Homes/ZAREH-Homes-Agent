/**
 * Before the app: sign in, two-factor (set up or verify), invitation and
 * password reset links. Passwords and codes are checked by the server; the
 * screens only explain what it says.
 */

import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import qrcode from "qrcode-generator";
import { api } from "../app/api.ts";
import { useAction } from "../app/useApi.ts";
import { useSession } from "../app/session.tsx";
import { navigate } from "../app/router.tsx";
import { Button, Notice, TextField } from "../ui/kit.tsx";

const MIN_PASSWORD = 12;

function Card({ title, children, footer }: { title: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="flex min-h-dvh items-start justify-center bg-page px-4 py-10 sm:items-center">
      <div className="w-full max-w-md">
        <p className="mb-4 text-center text-sm font-semibold tracking-tight text-ink">Zareh Homes · Back Office</p>
        <main className="rounded-xl border border-line bg-card p-6 shadow-sm">
          <h1 className="mb-5 text-xl font-semibold tracking-tight text-ink">{title}</h1>
          {children}
        </main>
        {footer && <div className="mt-4 text-center text-sm text-ink-2">{footer}</div>}
      </div>
    </div>
  );
}

export function SignIn() {
  const { signIn, notice } = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const action = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    await action.run(() => signIn(email.trim(), password));
  };
  return (
    <Card title="Sign in" footer={<>Forgot your password? Ask an admin to send you a reset link.</>}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        {notice && !action.error && <Notice kind="info">{notice}</Notice>}
        {action.error && <Notice kind="error">{action.error}</Notice>}
        <TextField label="Email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <TextField label="Password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        <Button type="submit" variant="primary" busy={action.busy} className="w-full" disabled={!email || !password}>Sign in</Button>
      </form>
    </Card>
  );
}

export function MfaVerify() {
  const { refresh, signOut, user } = useSession();
  const [code, setCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [left, setLeft] = useState<number | null>(null);
  const action = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const res = await action.run(() => api<{ recoveryCodesLeft: number }>("POST", "/api/auth/mfa/verify",
      useRecovery ? { recoveryCode: code.trim() } : { code: code.replace(/\s/g, "") }));
    if (!res) return;
    if (useRecovery) { setLeft(res.recoveryCodesLeft); return; }
    await refresh();
  };
  if (left !== null) {
    return (
      <Card title="Signed in with a recovery code">
        <Notice kind="warning" title={`${left} recovery code${left === 1 ? "" : "s"} left`}>
          That code can't be used again. If you lost your phone, ask an admin to reset your two-factor sign-in so you can set it up again.
        </Notice>
        <Button variant="primary" className="mt-4 w-full" onClick={() => void refresh()}>Continue</Button>
      </Card>
    );
  }
  return (
    <Card title="Two-factor sign-in" footer={<button type="button" className="underline" onClick={() => void signOut()}>Sign in as someone else</button>}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <p className="text-sm text-ink-2">
          {useRecovery ? "Enter one of the recovery codes you saved when you set up two-factor sign-in." : `Enter the 6-digit code from your authenticator app for ${user?.email ?? "your account"}.`}
        </p>
        {action.error && <Notice kind="error">{action.error}</Notice>}
        <TextField
          label={useRecovery ? "Recovery code" : "Authenticator code"}
          inputMode={useRecovery ? "text" : "numeric"}
          autoComplete="one-time-code"
          required
          value={code}
          onChange={(e) => setCode(e.target.value)}
          error={action.fields.code ?? action.fields.recoveryCode}
        />
        <Button type="submit" variant="primary" busy={action.busy} className="w-full" disabled={!code.trim()}>Verify</Button>
        <button type="button" className="w-full text-sm text-ink-2 underline" onClick={() => { setUseRecovery((v) => !v); setCode(""); action.clear(); }}>
          {useRecovery ? "Use my authenticator app instead" : "I can't use my authenticator app"}
        </button>
      </form>
    </Card>
  );
}

function QrCode({ text, label }: { text: string; label: string }) {
  const cells = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    const dark: [number, number][] = [];
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) dark.push([c, r]);
    return { n, dark };
  }, [text]);
  const size = cells.n + 8;
  return (
    <svg role="img" aria-label={label} viewBox={`-4 -4 ${size} ${size}`} className="mx-auto size-48 rounded-lg bg-white" shapeRendering="crispEdges">
      <rect x="-4" y="-4" width={size} height={size} fill="#fff" />
      <path fill="#000" d={cells.dark.map(([x, y]) => `M${x} ${y}h1v1h-1z`).join("")} />
    </svg>
  );
}

export function MfaEnrol() {
  const { refresh, signOut } = useSession();
  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(false);
  const start = useAction();
  const confirm = useAction();

  if (codes) {
    return (
      <Card title="Save your recovery codes">
        <p className="mb-3 text-sm text-ink-2">Each code works once, if you can't use your phone. They won't be shown again. Store them somewhere safe, not on this computer's desktop.</p>
        <ul aria-label="Recovery codes" className="mb-4 grid grid-cols-2 gap-2 rounded-lg bg-sunken p-3 font-mono text-sm text-ink">
          {codes.map((c) => <li key={c}>{c}</li>)}
        </ul>
        <label className="mb-4 flex items-start gap-2 text-sm text-ink">
          <input type="checkbox" className="mt-0.5 size-4" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
          I've saved these codes
        </label>
        <Button variant="primary" className="w-full" disabled={!saved} onClick={() => void refresh()}>Continue to the back office</Button>
      </Card>
    );
  }

  return (
    <Card title="Set up two-factor sign-in" footer={<button type="button" className="underline" onClick={() => void signOut()}>Sign out</button>}>
      <p className="mb-4 text-sm text-ink-2">
        Your role works with trust money or client records, so signing in needs a code from an authenticator app
        (Google Authenticator, Microsoft Authenticator, 1Password or similar) as well as your password.
      </p>
      {!setup ? (
        <>
          {start.error && <div className="mb-3"><Notice kind="error">{start.error}</Notice></div>}
          <Button variant="primary" className="w-full" busy={start.busy}
            onClick={async () => { const s = await start.run(() => api<{ secret: string; otpauthUri: string }>("POST", "/api/auth/mfa/enroll")); if (s) setSetup(s); }}>
            Start setup
          </Button>
        </>
      ) : (
        <form
          className="space-y-4"
          noValidate
          onSubmit={async (e) => {
            e.preventDefault();
            const res = await confirm.run(() => api<{ recoveryCodes: string[] }>("POST", "/api/auth/mfa/enroll/confirm", { code: code.replace(/\s/g, "") }));
            if (res) setCodes(res.recoveryCodes);
          }}
        >
          <ol className="list-decimal space-y-3 pl-5 text-sm text-ink">
            <li>
              Scan this with your authenticator app.
              <div className="my-3"><QrCode text={setup.otpauthUri} label="QR code for your authenticator app" /></div>
              <span className="text-ink-2">Can't scan? Enter this key instead: </span>
              <code className="break-all rounded bg-sunken px-1.5 py-0.5 text-xs" data-testid="mfa-secret">{setup.secret}</code>
            </li>
            <li>Enter the 6-digit code the app shows.</li>
          </ol>
          {confirm.error && <Notice kind="error">{confirm.error}</Notice>}
          <TextField label="Authenticator code" inputMode="numeric" autoComplete="one-time-code" required value={code}
            onChange={(e) => setCode(e.target.value)} error={confirm.fields.code} />
          <Button type="submit" variant="primary" busy={confirm.busy} className="w-full" disabled={!code.trim()}>Turn on two-factor sign-in</Button>
        </form>
      )}
    </Card>
  );
}

/** /accept-invite#token=… and /reset-password#token=… (the token stays out of server logs) */
export function SetPassword({ purpose }: { purpose: "invite" | "reset" }) {
  const token = useMemo(() => new URLSearchParams(location.hash.slice(1)).get("token") ?? "", []);
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [done, setDone] = useState(false);
  const action = useAction();
  const mismatch = again.length > 0 && again !== password;
  const tooShort = password.length > 0 && password.length < MIN_PASSWORD;
  const title = purpose === "invite" ? "Set your password" : "Choose a new password";

  if (!token) {
    return <Card title={title}><Notice kind="error">This link is incomplete. Open the full link you were sent, or ask an admin for a new one.</Notice></Card>;
  }
  if (done) {
    return (
      <Card title="Password set">
        <Notice kind="success">You can sign in now{purpose === "reset" ? ". Your other sessions were signed out." : "."}</Notice>
        <Button variant="primary" className="mt-4 w-full" onClick={() => { history.replaceState(null, "", "/"); navigate("/", { replace: true }); location.reload(); }}>
          Go to sign in
        </Button>
      </Card>
    );
  }
  return (
    <Card title={title}>
      <form
        className="space-y-4"
        noValidate
        onSubmit={async (e) => {
          e.preventDefault();
          if (mismatch || tooShort) return;
          const path = purpose === "invite" ? "/api/auth/invitations/accept" : "/api/auth/password-resets/complete";
          const ok = await action.run(() => api("POST", path, { token, password }));
          if (ok) setDone(true);
        }}
      >
        <p className="text-sm text-ink-2">At least {MIN_PASSWORD} characters. A short sentence you'll remember works well.</p>
        {action.error && <Notice kind="error">{action.error}</Notice>}
        <TextField label="New password" type="password" autoComplete="new-password" required value={password}
          onChange={(e) => setPassword(e.target.value)} error={tooShort ? `Use at least ${MIN_PASSWORD} characters` : action.fields.password} />
        <TextField label="Type it again" type="password" autoComplete="new-password" required value={again}
          onChange={(e) => setAgain(e.target.value)} error={mismatch ? "The two passwords don't match" : null} />
        <Button type="submit" variant="primary" busy={action.busy} className="w-full" disabled={!password || !again || mismatch || tooShort}>Set password</Button>
      </form>
    </Card>
  );
}
