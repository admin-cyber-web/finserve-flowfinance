/**
 * /security — the independent KIRAT MICRO CREDIT Security Department.
 *
 * This route deliberately shares nothing with the staff dashboard: its own
 * guard (bearer Security Operator token), its own layout, its own backend
 * module. A signed-in SUPER_ADMIN who types /security sees the Security
 * Department sign-in screen and cannot proceed — the browser session cookie
 * for the KMC dashboard is never accepted here.
 */
import { api } from "@/convex/_generated/api";
import { securityLogin, getStoredSecurityToken, storeSecurityToken } from "@/lib/security/client";
import { SEC } from "./securityUi";
import { SecurityCommandCenter } from "./SecurityCommandCenter";
import type { SecSession } from "./types";
import { useMutation, useQuery } from "convex/react";
import {
  AlertTriangle,
  ArrowRight,
  Fingerprint,
  KeyRound,
  Loader2,
  LockKeyhole,
  ShieldAlert,
  ShieldCheck,
  ShieldHalf,
  Timer,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";

export default function SecurityPortal() {
  const [token, setToken] = useState<string | null>(() => getStoredSecurityToken());
  const [notice, setNotice] = useState<string | null>(null);
  const sessionQuery = useQuery(
    api.security.session,
    token ? { token } : "skip",
  );
  const logout = useMutation(api.security.logout);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(id);
  }, []);

  const session = token ? (sessionQuery ?? null) : null;
  const loading = !!token && sessionQuery === undefined;

  // An invalid/expired token falls back to the sign-in screen. The backend
  // never trusts the stored value, so this is only a UX reduction.
  useEffect(() => {
    if (token && sessionQuery === null) {
      storeSecurityToken(null);
      setToken(null);
      setNotice("Your security session ended. Sign in again.");
    }
  }, [token, sessionQuery]);

  useEffect(() => {
    if (session && session.expiresAt <= now) {
      storeSecurityToken(null);
      setToken(null);
      setNotice("Security session timed out. Sign in again.");
    }
  }, [session, now]);

  const signOut = async () => {
    const current = token;
    storeSecurityToken(null);
    setToken(null);
    setNotice("You are signed out of the Security Department.");
    if (current) {
      try {
        await logout({ token: current });
      } catch {
        /* already revoked */
      }
    }
  };

  const acceptToken = (next: string, message?: string | null) => {
    storeSecurityToken(next);
    setToken(next);
    setNotice(message ?? null);
  };

  if (loading) {
    return (
      <PortalFrame>
        <div className="flex flex-1 items-center justify-center gap-3 text-[11px] uppercase tracking-[0.2em] text-zinc-500">
          <Loader2 className="size-4 animate-spin text-[#dc2626]" />
          Verifying security channel
        </div>
      </PortalFrame>
    );
  }

  if (!token || !session) {
    return (
      <PortalFrame>
        <AccessGate notice={notice} onAuthenticated={acceptToken} />
      </PortalFrame>
    );
  }

  if (session.mode === "BOOTSTRAP") {
    return (
      <PortalFrame>
        <ActivationSetup token={token} onActivated={acceptToken} onAbort={signOut} />
      </PortalFrame>
    );
  }

  if (session.mode === "ROTATION") {
    return (
      <PortalFrame>
        <ForcedRotation token={token} onRotated={acceptToken} onAbort={signOut} />
      </PortalFrame>
    );
  }

  return (
    <SecurityCommandCenter
      token={token}
      session={session}
      notice={notice}
      onSignOut={signOut}
    />
  );
}

/* ------------------------------- frame/layout ----------------------------- */

function PortalFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className={cn(SEC.page, "sec-grid relative flex min-h-screen flex-col")}>
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[#dc2626] to-transparent" />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(185,28,28,0.14),transparent_60%)]" />
      <div className="relative flex flex-1 flex-col">{children}</div>
      <footer className="relative border-t border-[#1a1d22] px-5 py-3 text-[9px] uppercase tracking-[0.22em] text-zinc-700">
        Independent Security Department · append-only audit chain · device
        authority is shared by authorized Security Operators and SUPER_ADMIN
      </footer>
    </div>
  );
}

/* ------------------------------ access gate ------------------------------- */

function AccessGate({
  notice,
  onAuthenticated,
}: {
  notice: string | null;
  onAuthenticated: (token: string, message?: string | null) => void;
}) {
  const state = useQuery(api.security.bootstrapState);
  const beginActivation = useMutation(api.security.beginActivation);
  const loginFallback = useMutation(api.security.login);
  const recover = useMutation(api.security.recover);

  const [mode, setMode] = useState<"login" | "activation" | "recovery">("login");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activationPin, setActivationPin] = useState("");
  const [operatorId, setOperatorId] = useState("");
  const [pin, setPin] = useState("");
  const [credential, setCredential] = useState("");
  const [recoveryForm, setRecoveryForm] = useState({
    recoveryCode: "",
    newPin: "",
    confirmPin: "",
    operatorId: "",
    newCredential: "",
    confirmCredential: "",
  });
  const [issuedRecovery, setIssuedRecovery] = useState<string | null>(null);

  const effectiveMode = useMemo<"login" | "activation" | "recovery">(() => {
    if (mode === "recovery") return "recovery";
    if (state && !state.initialized && state.bootstrapAvailable) return "activation";
    return "login";
  }, [mode, state]);

  if (state === undefined) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader2 className="size-5 animate-spin text-[#dc2626]" />
      </div>
    );
  }

  if (issuedRecovery) {
    return (
      <div className="mx-auto flex w-full max-w-lg flex-1 items-center px-5 py-16">
        <div className={cn(SEC.panel, "w-full p-6")}>
          <div className="mb-3 flex items-center gap-2 text-[#fbbf24]">
            <KeyRound className="size-4" />
            <span className={SEC.label}>Store this now</span>
          </div>
          <h2 className="text-lg font-black uppercase tracking-[0.12em] text-zinc-100">
            New recovery code
          </h2>
          <p className="mt-2 text-xs leading-relaxed text-zinc-500">
            This is the only time this code is shown. Only its hash is stored in
            the backend. Recovery never uses the activation PIN.
          </p>
          <pre className="mt-4 select-all border border-[#b91c1c]/40 bg-[#120708] p-4 text-center font-mono text-lg tracking-[0.18em] text-[#fecaca]">
            {issuedRecovery}
          </pre>
          <button
            type="button"
            className={cn(SEC.button, SEC.primary, "mt-5 w-full")}
            onClick={() => setIssuedRecovery(null)}
          >
            I have stored this code
          </button>
        </div>
      </div>
    );
  }

  const submitActivationPin = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await beginActivation({
        activationPin,
        userAgent: navigator.userAgent.slice(0, 200),
      });
      onAuthenticated(result.token, "Activation PIN accepted. Set the department PIN and first operator.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Activation failed.");
    } finally {
      setBusy(false);
    }
  };

  const submitLogin = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await securityLogin({ operatorId, credential, pin }, (args) =>
        loginFallback(args),
      );
      if (!result.ok || !result.token) {
        setError(result.message ?? "Sign-in failed.");
        return;
      }
      onAuthenticated(
        result.token,
        result.mustRotateCredential
          ? "Set your own operator credential to continue."
          : null,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  };

  const submitRecovery = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await recover(recoveryForm);
      onAuthenticated(result.token);
      setIssuedRecovery(result.recoveryCode);
      setMode("login");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Recovery failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-4 py-8 sm:px-6 lg:flex-row lg:items-center lg:gap-12 lg:py-16">
      <div className="mb-8 flex-1 lg:mb-0">
        <div className="inline-flex items-center gap-2 border border-[#b91c1c]/40 bg-[#170708] px-2.5 py-1 text-[9px] font-black uppercase tracking-[0.26em] text-[#f87171]">
          <ShieldAlert className="size-3" />
          Restricted facility
        </div>
        <h1 className="mt-5 text-3xl font-black uppercase leading-[1.05] tracking-[0.04em] text-zinc-50 sm:text-4xl">
          Security
          <br />
          <span className="text-[#b91c1c]">Command Center</span>
        </h1>
        <p className="mt-4 max-w-md text-xs leading-relaxed text-zinc-500">
          This portal is independent of the KMC administration dashboard. Staff
          credentials, SUPER_ADMIN sessions and dashboard roles have no authority
          here. Access requires the department PIN and a separate Security
          Operator credential.
        </p>
        <dl className="mt-6 grid max-w-md grid-cols-2 gap-px border border-[#1f232a] bg-[#1f232a] text-[10px]">
          {[
            ["Device authority", "SUPER_ADMIN (app owner)"],
            ["SUPER_ADMIN access", "Full authority"],
            ["Audit records", "Append-only + hash chain"],
            ["Sessions", "Bearer token, server-validated"],
          ].map(([k, v]) => (
            <div key={k} className="bg-[#0a0c0f] p-3">
              <dt className="uppercase tracking-[0.18em] text-zinc-600">{k}</dt>
              <dd className="mt-1 font-bold text-zinc-300">{v}</dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="w-full lg:max-w-md">
        <div className={cn(SEC.panel, "relative p-5 sm:p-6")}>
          <span className="absolute left-0 top-0 h-[2px] w-full bg-gradient-to-r from-[#b91c1c] via-[#dc2626] to-transparent" />
          <div className="mb-4 flex items-center justify-between">
            <div>
              <p className={SEC.heading}>
                {effectiveMode === "activation"
                  ? "Initial activation"
                  : effectiveMode === "recovery"
                    ? "Emergency recovery"
                    : "Security authentication"}
              </p>
              <p className="mt-1 text-[11px] text-zinc-600">
                {effectiveMode === "activation"
                  ? "One-time bootstrap credential"
                  : effectiveMode === "recovery"
                    ? "Recovery code + credential rotation"
                    : "Department PIN + operator credential"}
              </p>
            </div>
            <LockKeyhole className="size-4 text-[#b91c1c]" />
          </div>

          {notice ? (
            <p className="mb-4 border border-[#2c2f36] bg-[#0a0c0f] px-3 py-2 text-[11px] text-zinc-400">
              {notice}
            </p>
          ) : null}
          {error ? (
            <p className="mb-4 flex items-start gap-2 border border-[#b91c1c]/50 bg-[#1b0808] px-3 py-2 text-[11px] text-[#fca5a5]">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              {error}
            </p>
          ) : null}

          {state.initialized === false && !state.bootstrapAvailable && effectiveMode !== "recovery" ? (
            <div className="space-y-3">
              <p className="text-xs leading-relaxed text-zinc-400">
                The Security Department has not been provisioned on this
                deployment. A deployment owner must install the one-time
                bootstrap credential before any operator can activate the portal.
              </p>
              <p className="text-[10px] uppercase tracking-[0.18em] text-zinc-600">
                No operator account exists. SUPER_ADMIN cannot provision it.
              </p>
            </div>
          ) : effectiveMode === "activation" ? (
            <form onSubmit={submitActivationPin} className="space-y-3">
              <label className="block">
                <span className={SEC.label}>Activation PIN</span>
                <input
                  value={activationPin}
                  onChange={(e) => setActivationPin(e.target.value.replace(/\D/g, "").slice(0, 12))}
                  inputMode="numeric"
                  autoComplete="off"
                  autoFocus
                  className={cn(SEC.input, "mt-1.5 text-center text-2xl tracking-[0.5em]")}
                  placeholder="••••"
                />
              </label>
              <p className="text-[10px] leading-relaxed text-zinc-600">
                The activation PIN is single-use. After it is accepted you must
                set a real department PIN and create the first Security Operator
                before any security operation becomes available.
              </p>
              <button
                type="submit"
                disabled={busy || activationPin.length < 4}
                className={cn(SEC.button, SEC.primary, "w-full")}
              >
                {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Fingerprint className="size-3.5" />}
                Verify activation PIN
              </button>
            </form>
          ) : effectiveMode === "recovery" ? (
            <form onSubmit={submitRecovery} className="space-y-3">
              <label className="block">
                <span className={SEC.label}>Recovery code</span>
                <input
                  value={recoveryForm.recoveryCode}
                  onChange={(e) =>
                    setRecoveryForm({ ...recoveryForm, recoveryCode: e.target.value })
                  }
                  className={cn(SEC.input, "mt-1.5 font-mono uppercase")}
                  placeholder="KMC-XXXX-XXXX-XXXX"
                  autoComplete="off"
                />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className={SEC.label}>New 6-digit PIN</span>
                  <input
                    value={recoveryForm.newPin}
                    onChange={(e) =>
                      setRecoveryForm({
                        ...recoveryForm,
                        newPin: e.target.value.replace(/\D/g, "").slice(0, 6),
                      })
                    }
                    inputMode="numeric"
                    className={cn(SEC.input, "mt-1.5 tracking-[0.3em]")}
                  />
                </label>
                <label className="block">
                  <span className={SEC.label}>Confirm PIN</span>
                  <input
                    value={recoveryForm.confirmPin}
                    onChange={(e) =>
                      setRecoveryForm({
                        ...recoveryForm,
                        confirmPin: e.target.value.replace(/\D/g, "").slice(0, 6),
                      })
                    }
                    inputMode="numeric"
                    className={cn(SEC.input, "mt-1.5 tracking-[0.3em]")}
                  />
                </label>
              </div>
              <label className="block">
                <span className={SEC.label}>Operator ID</span>
                <input
                  value={recoveryForm.operatorId}
                  onChange={(e) =>
                    setRecoveryForm({
                      ...recoveryForm,
                      operatorId: e.target.value.toUpperCase().slice(0, 20),
                    })
                  }
                  className={cn(SEC.input, "mt-1.5 font-mono uppercase")}
                  placeholder="SO-0001"
                />
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className={SEC.label}>New operator credential</span>
                  <input
                    type="password"
                    value={recoveryForm.newCredential}
                    onChange={(e) =>
                      setRecoveryForm({ ...recoveryForm, newCredential: e.target.value })
                    }
                    className={cn(SEC.input, "mt-1.5")}
                    autoComplete="new-password"
                  />
                </label>
                <label className="block">
                  <span className={SEC.label}>Confirm credential</span>
                  <input
                    type="password"
                    value={recoveryForm.confirmCredential}
                    onChange={(e) =>
                      setRecoveryForm({
                        ...recoveryForm,
                        confirmCredential: e.target.value,
                      })
                    }
                    className={cn(SEC.input, "mt-1.5")}
                    autoComplete="new-password"
                  />
                </label>
              </div>
              <button
                type="submit"
                disabled={busy}
                className={cn(SEC.button, SEC.danger, "w-full")}
              >
                {busy ? <Loader2 className="size-3.5 animate-spin" /> : <KeyRound className="size-3.5" />}
                Recover security access
              </button>
              <button
                type="button"
                onClick={() => {
                  setMode("login");
                  setError(null);
                }}
                className="w-full text-[10px] uppercase tracking-[0.18em] text-zinc-600 hover:text-zinc-300"
              >
                Back to sign-in
              </button>
            </form>
          ) : (
            <form onSubmit={submitLogin} className="space-y-3">
              <label className="block">
                <span className={SEC.label}>Security operator ID</span>
                <input
                  value={operatorId}
                  onChange={(e) => setOperatorId(e.target.value.toUpperCase().slice(0, 20))}
                  className={cn(SEC.input, "mt-1.5 font-mono uppercase")}
                  placeholder="SO-0001"
                  autoComplete="username"
                  autoFocus
                />
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className={SEC.label}>Department PIN</span>
                  <input
                    type="password"
                    value={pin}
                    onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    inputMode="numeric"
                    className={cn(SEC.input, "mt-1.5 tracking-[0.3em]")}
                    autoComplete="off"
                  />
                </label>
                <label className="block">
                  <span className={SEC.label}>Operator credential</span>
                  <input
                    type="password"
                    value={credential}
                    onChange={(e) => setCredential(e.target.value)}
                    className={cn(SEC.input, "mt-1.5")}
                    autoComplete="current-password"
                  />
                </label>
              </div>
              <button
                type="submit"
                disabled={busy || !operatorId || pin.length < 4 || !credential}
                className={cn(SEC.button, SEC.primary, "w-full")}
              >
                {busy ? <Loader2 className="size-3.5 animate-spin" /> : <ShieldCheck className="size-3.5" />}
                Enter security department
              </button>
              <div className="flex items-center justify-between pt-1">
                {state.recoveryAvailable ? (
                  <button
                    type="button"
                    onClick={() => {
                      setMode("recovery");
                      setError(null);
                    }}
                    className="text-[10px] uppercase tracking-[0.18em] text-[#b91c1c] hover:text-[#f87171]"
                  >
                    Emergency recovery
                  </button>
                ) : (
                  <span className="text-[10px] uppercase tracking-[0.18em] text-zinc-700">
                    Recovery not configured
                  </span>
                )}
                <span className="flex items-center gap-1 text-[10px] uppercase tracking-[0.16em] text-zinc-700">
                  <Timer className="size-3" /> {state.sessionPolicyMinutes} min idle
                </span>
              </div>
            </form>
          )}
        </div>
        <p className="mt-3 flex items-center gap-2 text-[9px] uppercase tracking-[0.18em] text-zinc-700">
          <ArrowRight className="size-3" />
          Staff sign-in for KMC is available at <span className="font-mono">/auth</span>
        </p>
      </div>
    </div>
  );
}

/* ------------------------------ activation -------------------------------- */

function ActivationSetup({
  token,
  onActivated,
  onAbort,
}: {
  token: string;
  onActivated: (token: string, message?: string | null) => void;
  onAbort: () => void;
}) {
  const complete = useMutation(api.security.completeActivation);
  const [form, setForm] = useState({
    newPin: "",
    confirmPin: "",
    operatorId: "",
    operatorName: "",
    credential: "",
    confirmCredential: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await complete({ token, ...form });
      setRecoveryCode(result.recoveryCode);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Activation failed.");
    } finally {
      setBusy(false);
    }
  };

  if (recoveryCode) {
    return (
      <div className="mx-auto flex w-full max-w-lg flex-1 items-center px-5 py-16">
        <div className={cn(SEC.panel, "w-full p-6")}>
          <div className="mb-3 flex items-center gap-2 text-[#fbbf24]">
            <KeyRound className="size-4" />
            <span className={SEC.label}>Shown once</span>
          </div>
          <h2 className="text-lg font-black uppercase tracking-[0.12em] text-zinc-100">
            Emergency recovery code
          </h2>
          <p className="mt-2 text-xs leading-relaxed text-zinc-500">
            Store this outside the application. It is the independent recovery
            path if the department PIN or operator credential is lost, and it is
            never derived from the activation PIN. Only its hash is stored.
          </p>
          <pre className="mt-4 select-all border border-[#b91c1c]/40 bg-[#120708] p-4 text-center font-mono text-lg tracking-[0.18em] text-[#fecaca]">
            {recoveryCode}
          </pre>
          <button
            type="button"
            className={cn(SEC.button, SEC.primary, "mt-5 w-full")}
            onClick={() => onActivated(token, "Security Department activated.")}
          >
            Enter command center
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:px-6">
      <div className="mb-6">
        <p className={SEC.heading}>Activation · step 2 of 2</p>
        <h1 className="mt-2 text-2xl font-black uppercase tracking-[0.08em] text-zinc-50">
          Set credentials
        </h1>
        <p className="mt-2 max-w-xl text-xs leading-relaxed text-zinc-500">
          The activation PIN is consumed. Until you finish this step, the session
          can create the first operator and nothing else — no device approvals,
          no blocking, no revocation.
        </p>
      </div>
      {error ? (
        <p className="mb-4 border border-[#b91c1c]/50 bg-[#1b0808] px-3 py-2 text-[11px] text-[#fca5a5]">
          {error}
        </p>
      ) : null}
      <form onSubmit={submit} className={cn(SEC.panel, "space-y-4 p-5 sm:p-6")}>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className={SEC.label}>New department PIN (6 digits)</span>
            <input
              value={form.newPin}
              onChange={(e) => setForm({ ...form, newPin: e.target.value.replace(/\D/g, "").slice(0, 6) })}
              inputMode="numeric"
              className={cn(SEC.input, "mt-1.5 tracking-[0.3em]")}
              autoComplete="new-password"
            />
          </label>
          <label className="block">
            <span className={SEC.label}>Confirm PIN</span>
            <input
              value={form.confirmPin}
              onChange={(e) => setForm({ ...form, confirmPin: e.target.value.replace(/\D/g, "").slice(0, 6) })}
              inputMode="numeric"
              className={cn(SEC.input, "mt-1.5 tracking-[0.3em]")}
              autoComplete="new-password"
            />
          </label>
          <label className="block">
            <span className={SEC.label}>Operator ID</span>
            <input
              value={form.operatorId}
              onChange={(e) => setForm({ ...form, operatorId: e.target.value.toUpperCase().slice(0, 20) })}
              className={cn(SEC.input, "mt-1.5 font-mono uppercase")}
              placeholder="SO-0001"
            />
          </label>
          <label className="block">
            <span className={SEC.label}>Operator name</span>
            <input
              value={form.operatorName}
              onChange={(e) => setForm({ ...form, operatorName: e.target.value.slice(0, 60) })}
              className={cn(SEC.input, "mt-1.5")}
              placeholder="Security Administrator"
            />
          </label>
          <label className="block">
            <span className={SEC.label}>Operator credential</span>
            <input
              type="password"
              value={form.credential}
              onChange={(e) => setForm({ ...form, credential: e.target.value })}
              className={cn(SEC.input, "mt-1.5")}
              autoComplete="new-password"
              placeholder="At least 10 chars, letters + numbers"
            />
          </label>
          <label className="block">
            <span className={SEC.label}>Confirm credential</span>
            <input
              type="password"
              value={form.confirmCredential}
              onChange={(e) => setForm({ ...form, confirmCredential: e.target.value })}
              className={cn(SEC.input, "mt-1.5")}
              autoComplete="new-password"
            />
          </label>
        </div>
        <div className="flex flex-col gap-2 border-t border-[#1e2128] pt-4 sm:flex-row">
          <button type="submit" disabled={busy} className={cn(SEC.button, SEC.primary, "flex-1")}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <ShieldCheck className="size-3.5" />}
            Complete activation
          </button>
          <button type="button" onClick={onAbort} className={cn(SEC.button, SEC.ghost)}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

/* --------------------------- forced rotation ------------------------------ */

function ForcedRotation({
  token,
  onRotated,
  onAbort,
}: {
  token: string;
  onRotated: (token: string, message?: string | null) => void;
  onAbort: () => void;
}) {
  const rotate = useMutation(api.security.rotateOperatorCredential);
  const [form, setForm] = useState({ current: "", next: "", confirm: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await rotate({
        token,
        currentCredential: form.current,
        newCredential: form.next,
        confirmCredential: form.confirm,
      });
      onRotated(result.token, "Operator credential updated.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Rotation failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-md flex-1 px-5 py-16">
      <div className={cn(SEC.panel, "p-6")}>
        <p className={SEC.heading}>Mandatory credential rotation</p>
        <h1 className="mt-2 text-xl font-black uppercase tracking-[0.1em] text-zinc-50">
          Set your own credential
        </h1>
        <p className="mt-2 text-xs leading-relaxed text-zinc-500">
          This operator credential was issued by an administrator and must be
          replaced before the command center unlocks.
        </p>
        {error ? (
          <p className="mt-4 border border-[#b91c1c]/50 bg-[#1b0808] px-3 py-2 text-[11px] text-[#fca5a5]">
            {error}
          </p>
        ) : null}
        <form onSubmit={submit} className="mt-4 space-y-3">
          <label className="block">
            <span className={SEC.label}>Current credential</span>
            <input
              type="password"
              value={form.current}
              onChange={(e) => setForm({ ...form, current: e.target.value })}
              className={cn(SEC.input, "mt-1.5")}
              autoComplete="current-password"
            />
          </label>
          <label className="block">
            <span className={SEC.label}>New credential</span>
            <input
              type="password"
              value={form.next}
              onChange={(e) => setForm({ ...form, next: e.target.value })}
              className={cn(SEC.input, "mt-1.5")}
              autoComplete="new-password"
            />
          </label>
          <label className="block">
            <span className={SEC.label}>Confirm new credential</span>
            <input
              type="password"
              value={form.confirm}
              onChange={(e) => setForm({ ...form, confirm: e.target.value })}
              className={cn(SEC.input, "mt-1.5")}
              autoComplete="new-password"
            />
          </label>
          <button type="submit" disabled={busy} className={cn(SEC.button, SEC.primary, "w-full")}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <KeyRound className="size-3.5" />}
            Save new credential
          </button>
          <button type="button" onClick={onAbort} className="w-full text-[10px] uppercase tracking-[0.18em] text-zinc-600 hover:text-zinc-300">
            Sign out instead
          </button>
        </form>
      </div>
    </div>
  );
}

export type { SecSession };
