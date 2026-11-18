/**
 * Security Command Center modules. Every mutation here goes through the
 * security backend with a bearer token; the UI never sends a staff role.
 */
import { api } from "@/convex/_generated/api";
import {
  SECURITY_MODULES,
  SECURITY_PERMISSIONS,
  SECURITY_PERMISSION_LABELS,
  SECURITY_ROLES,
  SECURITY_ROLE_LABELS,
  type SecurityPermission,
  type SecurityRole,
} from "@/lib/security/permissions";
import type { Id } from "@/convex/_generated/dataModel";
import { useMutation, useQuery } from "convex/react";
import {
  Activity,
  AlertOctagon,
  Ban,
  Check,
  ChevronRight,
  CircleSlash,
  Fingerprint,
  KeyRound,
  Loader2,
  Lock,
  LogOut,
  MonitorSmartphone,
  Plus,
  RefreshCcw,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  ShieldHalf,
  Smartphone,
  UserCog,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import {
  SEC,
  SecBadge,
  SecEmpty,
  SecField,
  SecModal,
  SecStat,
  eventTone,
  fmtAgo,
  fmtDateTime,
  statusTone,
} from "./securityUi";
import { canSecurity, type SecSession } from "./types";

type TabKey = (typeof SECURITY_MODULES)[number]["key"];
type ActionValues = { reason: string; credential: string };

export function SecurityCommandCenter({
  token,
  session,
  notice,
  onSignOut,
}: {
  token: string;
  session: SecSession;
  notice: string | null;
  onSignOut: () => void | Promise<void>;
}) {
  const [tab, setTab] = useState<TabKey>("overview");
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const operator = session.operator;
  const modules = SECURITY_MODULES.filter((m) =>
    canSecurity(session, m.permission),
  );
  const activeTab = modules.some((m) => m.key === tab) ? tab : "overview";
  const remaining = Math.max(0, Math.floor((session.expiresAt - now) / 60000));

  return (
    <div className={cn(SEC.page, "sec-grid relative flex min-h-screen flex-col")}>
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[#dc2626] to-transparent" />
      <header className="sticky top-0 z-30 border-b border-[#1e2126] bg-[#07080b]/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1500px] items-center gap-3 px-4 py-3">
          <div className="relative flex size-10 shrink-0 items-center justify-center border border-[#b91c1c]/50 bg-[#160708]">
            <ShieldHalf className="size-5 text-[#f87171] sec-pulse" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[12px] font-black uppercase tracking-[0.28em] text-zinc-100">
              Kirat Micro Credit
            </p>
            <p className="truncate text-[9px] font-bold uppercase tracking-[0.2em] text-[#b91c1c]">
              Independent Security Department · restricted
            </p>
          </div>
          <div className="hidden items-center gap-2 sm:flex">
            <SecBadge tone="ok">
              <ShieldCheck className="size-2.5" /> session verified
            </SecBadge>
            <SecBadge tone={remaining <= 5 ? "danger" : "neutral"}>
              <Activity className="size-2.5" /> {remaining} min
            </SecBadge>
          </div>
          <div className="hidden text-right md:block">
            <p className="text-[11px] font-bold text-zinc-200">
              {operator?.name ?? "Operator"}
            </p>
            <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-zinc-500">
              {operator?.operatorId ?? "—"} ·{" "}
              {operator
                ? (SECURITY_ROLE_LABELS[operator.role as SecurityRole] ?? operator.role)
                : ""}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void onSignOut()}
            className={cn(SEC.button, SEC.ghost, "px-2.5 py-1.5")}
          >
            <LogOut className="size-3" /> Sign out
          </button>
        </div>
        <nav className="mx-auto flex max-w-[1500px] gap-1 overflow-x-auto px-3 pb-2">
          {modules.map((m) => (
            <button
              key={m.key}
              type="button"
              onClick={() => setTab(m.key)}
              className={cn(
                "shrink-0 border-b-2 px-3 py-2 text-[10px] font-black uppercase tracking-[0.16em] transition",
                activeTab === m.key
                  ? "border-[#dc2626] text-zinc-100"
                  : "border-transparent text-zinc-500 hover:text-zinc-300",
              )}
            >
              {m.label}
            </button>
          ))}
        </nav>
      </header>

      <main className="relative mx-auto w-full max-w-[1500px] flex-1 px-4 py-6">
        {notice ? (
          <p className="mb-4 border border-[#2a2e36] bg-[#0b0d10] px-3 py-2 text-[11px] text-zinc-400">
            {notice}
          </p>
        ) : null}
        {activeTab === "overview" ? <OverviewModule token={token} session={session} onOpen={setTab} /> : null}
        {activeTab === "devices" ? <DevicesModule token={token} session={session} /> : null}
        {activeTab === "events" ? <EventsModule token={token} /> : null}
        {activeTab === "incidents" ? <IncidentsModule token={token} /> : null}
        {activeTab === "operators" ? <OperatorsModule token={token} session={session} /> : null}
        {activeTab === "audit" ? <AuditModule token={token} /> : null}
        {activeTab === "settings" ? <SettingsModule token={token} session={session} /> : null}
      </main>

      <footer className="border-t border-[#1a1d22] px-4 py-3 text-[9px] uppercase tracking-[0.2em] text-zinc-700">
        Auditor scope: append-only · generated server-side · SUPER_ADMIN can
        manage devices · operator & PIN management stays with Security Operators
      </footer>
    </div>
  );
}

/* ----------------------------- shared pieces ------------------------------ */

function ModuleHeader({
  eyebrow,
  title,
  description,
  right,
}: {
  eyebrow: string;
  title: string;
  description: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <p className={SEC.heading}>{eyebrow}</p>
        <h1 className="mt-1 text-xl font-black uppercase tracking-[0.08em] text-zinc-50">
          {title}
        </h1>
        <p className="mt-1 max-w-2xl text-[11px] leading-relaxed text-zinc-500">
          {description}
        </p>
      </div>
      {right}
    </div>
  );
}

function ErrorBar({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p className="mb-3 flex items-start gap-2 border border-[#b91c1c]/50 bg-[#1b0808] px-3 py-2 text-[11px] text-[#fca5a5]">
      <AlertOctagon className="mt-0.5 size-3.5 shrink-0" />
      {error}
    </p>
  );
}

function ActionDialog({
  open,
  title,
  description,
  submitLabel,
  tone = "danger",
  requireReason = true,
  requireCredential = false,
  busy,
  error,
  extra,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  description: string;
  submitLabel: string;
  tone?: "danger" | "primary";
  requireReason?: boolean;
  requireCredential?: boolean;
  busy: boolean;
  error: string | null;
  extra?: React.ReactNode;
  onClose: () => void;
  onSubmit: (values: ActionValues) => void | Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [credential, setCredential] = useState("");
  useEffect(() => {
    if (!open) {
      setReason("");
      setCredential("");
    }
  }, [open]);
  return (
    <SecModal open={open} title={title} subtitle={description} onClose={onClose}>
      <ErrorBar error={error} />
      <div className="space-y-3">
        {extra}
        {requireReason ? (
          <SecField label="Reason (recorded in the audit chain)">
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              className={SEC.input}
              placeholder="Why is this action being taken?"
            />
          </SecField>
        ) : null}
        {requireCredential ? (
          <SecField
            label="Your operator credential"
            hint="Additional verification for this sensitive operation."
          >
            <input
              type="password"
              value={credential}
              onChange={(e) => setCredential(e.target.value)}
              className={SEC.input}
              autoComplete="current-password"
            />
          </SecField>
        ) : null}
        <div className="flex flex-col gap-2 pt-1 sm:flex-row">
          <button
            type="button"
            disabled={busy || (requireReason && reason.trim().length < 5) || (requireCredential && !credential)}
            onClick={() => void onSubmit({ reason, credential })}
            className={cn(SEC.button, tone === "danger" ? SEC.danger : SEC.primary, "flex-1")}
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <ShieldAlert className="size-3.5" />}
            {submitLabel}
          </button>
          <button type="button" onClick={onClose} className={cn(SEC.button, SEC.ghost)}>
            Cancel
          </button>
        </div>
      </div>
    </SecModal>
  );
}

/* -------------------------------- overview -------------------------------- */

function OverviewModule({
  token,
  session,
  onOpen,
}: {
  token: string;
  session: SecSession;
  onOpen: (tab: TabKey) => void;
}) {
  const data = useQuery(api.security.dashboard, { token });
  if (!data) {
    return <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-zinc-600"><Loader2 className="size-4 animate-spin" /> Loading security posture</div>;
  }
  return (
    <div>
      <ModuleHeader
        eyebrow={`Command center · ${session.operator?.operatorId ?? ""}`}
        title="Security posture"
        description="Live counts from the device registry, security event log and audit chain. Nothing on this screen is simulated."
        right={
          <div className="flex gap-2">
            <button type="button" onClick={() => onOpen("devices")} className={cn(SEC.button, SEC.primary)}>
              <MonitorSmartphone className="size-3" /> Device queue
            </button>
            <button type="button" onClick={() => onOpen("events")} className={cn(SEC.button, SEC.ghost)}>
              <Activity className="size-3" /> Monitoring
            </button>
          </div>
        }
      />
      <div className="grid grid-cols-2 gap-px border border-[#1f232a] bg-[#1f232a] sm:grid-cols-3 lg:grid-cols-4">
        <SecStat label="Authorized devices" value={data.devices.authorized} hint="one active device per staff ID" tone="ok" />
        <SecStat label="Pending requests" value={data.devices.pending} hint="awaiting security approval" tone={data.devices.pending ? "warn" : "neutral"} />
        <SecStat label="Blocked devices" value={data.devices.blocked} hint="session-invalidated" tone={data.devices.blocked ? "danger" : "neutral"} />
        <SecStat label="Revoked / replaced" value={data.devices.revoked} />
        <SecStat label="Unauthorized attempts" value={data.unauthorizedAttempts24h} hint="last 24 hours" tone={data.unauthorizedAttempts24h ? "danger" : "neutral"} />
        <SecStat label="Open incidents" value={data.incidents.open} hint={`${data.incidents.total} total`} tone={data.incidents.open ? "warn" : "neutral"} />
        <SecStat label="Active operators" value={data.operators.active} hint={`${data.operators.failedLogins24h} failed sign-ins / 24h`} />
        <SecStat label="Session policy" value={`${data.config.sessionPolicyMinutes}m`} hint="idle timeout" />
      </div>

      <div className="mt-5 grid grid-cols-2 gap-px border border-[#1f232a] bg-[#1f232a] sm:grid-cols-4">
        <SecStat label="SUPER_ADMIN devices" value={data.devices.superAdmin} hint="app owner — registry owner" />
        <SecStat label="Staff devices" value={data.devices.staff} hint="staff-level enrollments" />
        <SecStat label="Operator devices" value={data.devices.securityOperator} hint="operators use PIN + credential" />
        <SecStat
          label="Cryptographic keys"
          value={data.devices.cryptographicallyEnrolled}
          hint={`${data.devices.pendingKeys} legacy pending without a key`}
          tone={data.devices.pendingKeys ? "warn" : "ok"}
        />
        <SecStat label="KMC sign-ins / 24h" value={data.loginAttempts.total24h} hint={`${data.loginAttempts.failed24h} failed`} tone={data.loginAttempts.failed24h ? "warn" : "neutral"} />
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <section className={cn(SEC.panel, "p-4")}>
          <div className="mb-3 flex items-center justify-between">
            <p className={SEC.heading}>Security monitoring</p>
            <button type="button" onClick={() => onOpen("events")} className="flex items-center gap-1 text-[9px] uppercase tracking-[0.16em] text-[#b91c1c] hover:text-[#f87171]">
              All events <ChevronRight className="size-3" />
            </button>
          </div>
          {data.recentEvents.length === 0 ? (
            <SecEmpty>No security events recorded yet</SecEmpty>
          ) : (
            <ul className="divide-y divide-[#1c1f25]">
              {data.recentEvents.slice(0, 8).map((e) => (
                <li key={e._id} className="flex items-start gap-3 py-2">
                  <SecBadge tone={eventTone(e.kind)}>{e.kind.replace(/_/g, " ")}</SecBadge>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[11px] text-zinc-300">
                      {e.staffName} <span className="text-zinc-600">·</span> {e.staffId ?? "—"}
                    </p>
                    <p className="truncate text-[10px] text-zinc-600">{e.detail}</p>
                  </div>
                  <span className="shrink-0 text-[9px] uppercase tracking-[0.12em] text-zinc-600">{fmtAgo(e.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className={cn(SEC.panel, "p-4")}>
          <div className="mb-3 flex items-center justify-between">
            <p className={SEC.heading}>Audit chain</p>
            <button type="button" onClick={() => onOpen("audit")} className="flex items-center gap-1 text-[9px] uppercase tracking-[0.16em] text-[#b91c1c] hover:text-[#f87171]">
              Full history <ChevronRight className="size-3" />
            </button>
          </div>
          {data.recentAudit.length === 0 ? (
            <SecEmpty>No audit entries yet</SecEmpty>
          ) : (
            <ul className="divide-y divide-[#1c1f25]">
              {data.recentAudit.slice(0, 8).map((a) => (
                <li key={a._id} className="py-2">
                  <div className="flex items-center justify-between gap-3">
                    <p className="truncate font-mono text-[10px] uppercase tracking-[0.1em] text-zinc-300">
                      {a.action.replace(/_/g, " ")}
                    </p>
                    <span className="shrink-0 text-[9px] text-zinc-600">{fmtAgo(a.at)}</span>
                  </div>
                  <p className="truncate text-[10px] text-zinc-600">
                    {a.operatorId} · {a.ref} · {a.targetType} {a.targetId}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className={cn(SEC.panelSoft, "mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 p-4 text-[10px] uppercase tracking-[0.16em] text-zinc-500")}>
        <span className="flex items-center gap-1.5"><Lock className="size-3 text-[#b91c1c]" /> PIN rotated {fmtDateTime(data.config.pinChangedAt)}</span>
        <span className="flex items-center gap-1.5"><KeyRound className="size-3 text-[#b91c1c]" /> Recovery {data.config.recoveryConfigured ? "configured" : "not configured"}</span>
        <span className="flex items-center gap-1.5"><ShieldCheck className="size-3 text-[#b91c1c]" /> No SUPER_ADMIN authority</span>
      </section>
    </div>
  );
}

/* --------------------------------- devices -------------------------------- */

const DEVICE_FILTERS = ["PENDING", "AUTHORIZED", "BLOCKED", "REVOKED", "ALL"] as const;

function DevicesModule({ token, session }: { token: string; session: SecSession }) {
  const [filter, setFilter] = useState<(typeof DEVICE_FILTERS)[number]>("PENDING");
  const all = useQuery(api.security.devices, { token });
  const devices = useMemo(
    () => (all ?? []).filter((d) => filter === "ALL" || d.status === filter || (filter === "REVOKED" && d.status === "REPLACED")),
    [all, filter],
  );

  const approve = useMutation(api.security.approveDevice);
  const reject = useMutation(api.security.rejectDevice);
  const block = useMutation(api.security.blockDevice);
  const unblock = useMutation(api.security.unblockDevice);
  const revoke = useMutation(api.security.revokeDevice);
  const replace = useMutation(api.security.replaceDevice);
  const revokeSessions = useMutation(api.security.revokeDeviceSessions);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<{
    kind: "approve" | "reject" | "block" | "unblock" | "revoke" | "replace" | "sessions";
    deviceId: string;
    staffName: string;
    staffId?: string | null;
  } | null>(null);
  const [replacementId, setReplacementId] = useState<string>("");
  const [detailsId, setDetailsId] = useState<Id<"securityDevices"> | null>(null);

  const canApprove = canSecurity(session, "security.devices.approve");
  const canBlock = canSecurity(session, "security.devices.block");
  const canRevoke = canSecurity(session, "security.devices.revoke");
  const canReplace = canSecurity(session, "security.devices.replace");

  const close = () => {
    setAction(null);
    setReplacementId("");
    setError(null);
  };

  const submit = async ({ reason, credential }: ActionValues) => {
    if (!action) return;
    setBusy(true);
    setError(null);
    try {
      switch (action.kind) {
        case "approve":
          await approve({
            token,
            deviceId: action.deviceId as Id<"securityDevices">,
            reason: reason || undefined,
            replaceActive: false,
          });
          break;
        case "reject":
          await reject({ token, deviceId: action.deviceId as Id<"securityDevices">, reason });
          break;
        case "block":
          await block({ token, deviceId: action.deviceId as Id<"securityDevices">, reason, confirmCredential: credential });
          break;
        case "unblock":
          await unblock({ token, deviceId: action.deviceId as Id<"securityDevices">, reason: reason || undefined });
          break;
        case "revoke":
          await revoke({ token, deviceId: action.deviceId as Id<"securityDevices">, reason, confirmCredential: credential });
          break;
        case "sessions":
          await revokeSessions({ token, deviceId: action.deviceId as Id<"securityDevices">, reason, confirmCredential: credential });
          break;
        case "replace": {
          if (!replacementId) throw new Error("Select the pending replacement device.");
          await replace({
            token,
            oldDeviceId: action.deviceId as Id<"securityDevices">,
            newDeviceId: replacementId as Id<"securityDevices">,
            reason,
            confirmCredential: credential,
          });
          break;
        }
      }
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <ModuleHeader
        eyebrow="Device authorization"
        title="Registered devices"
        description="Exclusive authority of the Security Department. Approving a device authorizes that browser for one staff ID; blocking, revoking and replacing invalidate the staff session immediately."
        right={
          <div className="flex flex-wrap gap-1">
            {DEVICE_FILTERS.map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className={cn(
                  "border px-2 py-1 text-[9px] font-black uppercase tracking-[0.14em]",
                  filter === f
                    ? "border-[#b91c1c] bg-[#1c0808] text-[#fca5a5]"
                    : "border-[#262a31] text-zinc-500 hover:text-zinc-300",
                )}
              >
                {f}
              </button>
            ))}
          </div>
        }
      />
      <ErrorBar error={error} />
      {all === undefined ? (
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-zinc-600"><Loader2 className="size-4 animate-spin" /> Loading devices</div>
      ) : devices.length === 0 ? (
        <SecEmpty>No devices in this state</SecEmpty>
      ) : (
        <div className="overflow-x-auto border border-[#1f232a]">
          <table className="w-full min-w-[980px] border-collapse text-left">
            <thead>
              <tr className="bg-[#0b0d10] text-[9px] uppercase tracking-[0.16em] text-zinc-500">
                {["Staff", "Device", "Status", "Enrollment key", "Last verified", "Requested", "Decision", "Actions"].map((h) => (
                  <th key={h} className="border-b border-[#1f232a] px-3 py-2 font-black">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {devices.map((d) => (
                <tr key={d._id} className="border-b border-[#15181d] align-top hover:bg-[#0c0e12]">
                  <td className="px-3 py-2.5">
                    <p className="text-[11px] font-bold text-zinc-200">{d.staffName}</p>
                    <p className="font-mono text-[10px] text-zinc-600">{d.staffId ?? "—"} · {d.role}</p>
                  </td>
                  <td className="px-3 py-2.5">
                    <p className="flex items-center gap-1.5 text-[11px] text-zinc-300"><Smartphone className="size-3 text-zinc-600" />{d.label}</p>
                    <p className="text-[10px] text-zinc-600">
                      {[d.category, d.os, d.browser && `${d.browser} ${d.browserVersion ?? ""}`.trim()]
                        .filter(Boolean)
                        .join(" · ") || d.platform || "Web"}
                      {" "}· reported
                    </p>
                  </td>
                  <td className="px-3 py-2.5">
                    <SecBadge tone={statusTone(d.status)}>{d.status}</SecBadge>
                    {d.multipleAuthorized ? <p className="mt-1 text-[9px] uppercase tracking-[0.1em] text-[#f87171]">policy conflict</p> : null}
                  </td>
                  <td className="px-3 py-2.5">
                    {d.enrollmentId ? (
                      <>
                        <span className="block font-mono text-[10px] font-bold text-zinc-300">{d.enrollmentId}</span>
                        <span className="font-mono text-[9px] text-zinc-600">
                          {d.publicKeyFingerprint ?? "no key fingerprint"}
                        </span>
                      </>
                    ) : (
                      <span className="text-[10px] text-zinc-500">legacy request · no key</span>
                    )}
                    <p className="text-[10px] text-zinc-600">{d.ip ?? "ip unavailable"}</p>
                  </td>
                  <td className="px-3 py-2.5 text-[10px] text-zinc-400">
                    {d.lastVerifiedAt ? fmtAgo(d.lastVerifiedAt) : <span className="text-zinc-600">never</span>}
                  </td>
                  <td className="px-3 py-2.5 text-[10px] text-zinc-500">{fmtDateTime(d.requestedAt)}</td>
                  <td className="px-3 py-2.5 text-[10px] text-zinc-500">
                    {d.decidedBy ? <>{d.decidedBy}<br />{fmtDateTime(d.decidedAt)}</> : "—"}
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex flex-wrap gap-1">
                      {d.status === "PENDING" && canApprove ? (
                        <>
                          <button type="button" onClick={() => setAction({ kind: "approve", deviceId: d._id, staffName: d.staffName, staffId: d.staffId })} className={cn(SEC.button, SEC.primary, "px-2 py-1")}>
                            <Check className="size-3" /> Approve
                          </button>
                          <button type="button" onClick={() => setAction({ kind: "reject", deviceId: d._id, staffName: d.staffName, staffId: d.staffId })} className={cn(SEC.button, SEC.ghost, "px-2 py-1")}>
                            <X className="size-3" /> Reject
                          </button>
                        </>
                      ) : null}
                      {d.status === "AUTHORIZED" && canRevoke ? (
                        <button type="button" onClick={() => setAction({ kind: "revoke", deviceId: d._id, staffName: d.staffName, staffId: d.staffId })} className={cn(SEC.button, SEC.danger, "px-2 py-1")}>
                          <Ban className="size-3" /> Revoke
                        </button>
                      ) : null}
                      {d.status === "AUTHORIZED" && canReplace ? (
                        <button type="button" onClick={() => setAction({ kind: "replace", deviceId: d._id, staffName: d.staffName, staffId: d.staffId })} className={cn(SEC.button, SEC.ghost, "px-2 py-1")}>
                          <RefreshCcw className="size-3" /> Replace
                        </button>
                      ) : null}
                      {d.status === "AUTHORIZED" && canBlock ? (
                        <button type="button" onClick={() => setAction({ kind: "block", deviceId: d._id, staffName: d.staffName, staffId: d.staffId })} className={cn(SEC.button, SEC.danger, "px-2 py-1")}>
                          <CircleSlash className="size-3" /> Block
                        </button>
                      ) : null}
                      {d.status === "BLOCKED" && canBlock ? (
                        <button type="button" onClick={() => setAction({ kind: "unblock", deviceId: d._id, staffName: d.staffName, staffId: d.staffId })} className={cn(SEC.button, SEC.ghost, "px-2 py-1")}>
                          <RotateCcw className="size-3" /> Unblock
                        </button>
                      ) : null}
                      {d.status === "BLOCKED" && canRevoke ? (
                        <button type="button" onClick={() => setAction({ kind: "revoke", deviceId: d._id, staffName: d.staffName, staffId: d.staffId })} className={cn(SEC.button, SEC.danger, "px-2 py-1")}>
                          <Ban className="size-3" /> Revoke
                        </button>
                      ) : null}
                      {canRevoke ? (
                        <button type="button" onClick={() => setAction({ kind: "sessions", deviceId: d._id, staffName: d.staffName, staffId: d.staffId })} className={cn(SEC.button, SEC.ghost, "px-2 py-1")}>
                          <LogOut className="size-3" /> Sessions
                        </button>
                      ) : null}
                      <button type="button" onClick={() => setDetailsId(d._id as Id<"securityDevices">)} className={cn(SEC.button, SEC.ghost, "px-2 py-1")}>
                        <Activity className="size-3" /> Details
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <DeviceDetailDialog token={token} deviceId={detailsId} onClose={() => setDetailsId(null)} />

      <ActionDialog
        open={!!action}
        title={
          action
            ? `${action.kind.charAt(0).toUpperCase()}${action.kind.slice(1)} device · ${action.staffName}`
            : "Device action"
        }
        description={
          action?.kind === "sessions"
            ? "Ends every KMC session for this staff member without changing the device decision. Recorded in the hash-chained audit log."
            : action?.kind === "revoke" || action?.kind === "block" || action?.kind === "replace"
              ? "This immediately invalidates the staff member's active sessions. The backend records it in the hash-chained audit log."
              : "The Security Department is the only authority for this device action."
        }
        submitLabel={action?.kind === "sessions" ? "Revoke sessions" : action ? action.kind : "Confirm"}
        requireReason={action?.kind !== "approve" && action?.kind !== "unblock"}
        requireCredential={action?.kind === "block" || action?.kind === "revoke" || action?.kind === "replace" || action?.kind === "sessions"}
        busy={busy}
        error={error}
        onClose={close}
        onSubmit={submit}
        extra={
          action?.kind === "replace" ? (
            <SecField label="Replacement device (pending request)" hint="Only pending devices of the same staff ID can receive authorization.">
              <select
                value={replacementId}
                onChange={(e) => setReplacementId(e.target.value)}
                className={SEC.input}
              >
                <option value="">Select a pending device…</option>
                                  {(all ?? [])
                  .filter((d) => d.status === "PENDING" && d.staffId === action?.staffId)
                  .map((d) => (
                    <option key={d._id} value={d._id}>
                      {d.label} · {d.fingerprintShort} · {fmtDateTime(d.requestedAt)}
                    </option>
                  ))}
              </select>
            </SecField>
          ) : null
        }
      />
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-[#15181d] py-1.5">
      <span className="text-[9px] font-black uppercase tracking-[0.16em] text-zinc-600">{label}</span>
      <span className="text-right text-[11px] font-semibold text-zinc-300">{value}</span>
    </div>
  );
}

function DeviceDetailDialog({
  token,
  deviceId,
  onClose,
}: {
  token: string;
  deviceId: Id<"securityDevices"> | null;
  onClose: () => void;
}) {
  const detail = useQuery(
    api.security.deviceDetails,
    deviceId ? { token, deviceId } : "skip",
  );
  const d = detail?.device;
  return (
    <SecModal
      open={!!deviceId}
      title="Device details"
      subtitle="Cryptographic enrollment, reported browser information and the complete device history."
      onClose={onClose}
    >
      {!d ? (
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-zinc-600">
          <Loader2 className="size-4 animate-spin" /> Loading device
        </div>
      ) : (
        <div className="space-y-4">
          <div>
            <DetailRow label="Enrollment ID" value={<span className="font-mono">{d.enrollmentId ?? "legacy (no key)"}</span>} />
            <DetailRow label="Owner" value={`${d.staffName} · ${d.staffId ?? "—"} · ${d.role}`} />
            <DetailRow label="Status" value={<SecBadge tone={statusTone(d.status)}>{d.status}</SecBadge>} />
            <DetailRow label="Key enrolled" value={d.keyEnrolled ? "ECDSA P-256 public key" : "none"} />
            <DetailRow label="Key fingerprint" value={<span className="font-mono text-[10px]">{d.publicKeyFingerprint ?? "—"}</span>} />
            <DetailRow label="Reported browser" value={`${d.browser ?? "—"} ${d.browserVersion ?? ""}`.trim()} />
            <DetailRow label="Reported OS" value={d.os ?? "—"} />
            <DetailRow label="Device category" value={`${d.category ?? "—"} (reported, not verified hardware)`} />
            <DetailRow label="First registered" value={fmtDateTime(d.enrolledAt ?? d.requestedAt)} />
            <DetailRow label="Last verified" value={d.lastVerifiedAt ? fmtDateTime(d.lastVerifiedAt) : "never"} />
            <DetailRow label="Last IP" value={d.ip ?? "not recorded"} />
            <DetailRow label="Revoked" value={d.revokedAt ? `${fmtDateTime(d.revokedAt)} — ${d.revokeReason ?? "no reason"}` : "no"} />
            <DetailRow label="Active KMC sessions" value={detail.activeSessions} />
            <DetailRow label="Decision" value={d.decidedBy ? `${d.decidedBy} · ${fmtDateTime(d.decidedAt)}` : "—"} />
          </div>
          <div>
            <p className="mb-2 text-[9px] font-black uppercase tracking-[0.18em] text-zinc-500">
              Enrollment & login history
            </p>
            {detail.history.length === 0 ? (
              <p className="text-[11px] text-zinc-600">No events recorded.</p>
            ) : (
              <ul className="max-h-64 space-y-2 overflow-y-auto">
                {detail.history.map((e) => (
                  <li key={e._id} className="border-l-2 border-[#b91c1c]/60 pl-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[10px] font-black uppercase tracking-[0.12em] text-zinc-300">{e.kind}</span>
                      <span className="shrink-0 text-[9px] text-zinc-600">{fmtDateTime(e.at)}</span>
                    </div>
                    <p className="text-[10px] text-zinc-500">{e.detail ?? "—"}</p>
                    <p className="font-mono text-[9px] text-zinc-700">actor {e.actor}{e.ip ? ` · ${e.ip}` : ""}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </SecModal>
  );
}

/* --------------------------------- events --------------------------------- */

const EVENT_FILTERS = [
  ["ALL", "All"],
  ["UNAUTHORIZED_ATTEMPT", "Unauthorized"],
  ["DEVICE_REQUESTED", "Requests"],
  ["DEVICE_APPROVED", "Approved"],
  ["DEVICE_BLOCKED", "Blocked"],
  ["DEVICE_REVOKED", "Revoked"],
  ["DEVICE_REPLACED", "Replaced"],
] as const;

function EventsModule({ token }: { token: string }) {
  const [filter, setFilter] = useState<string>("ALL");
  const events = useQuery(api.security.deviceEvents, {
    token,
    kind: filter === "ALL" ? undefined : filter,
    limit: 150,
  });
  const attempts = useQuery(api.security.loginAttempts, { token, limit: 40 });
  return (
    <div>
      <ModuleHeader
        eyebrow="Security monitoring"
        title="Security event log"
        description="Every registration, approval, block, revocation and unauthorized attempt recorded by the backend, with IP where the deployment edge supplied it."
        right={
          <div className="flex flex-wrap gap-1">
            {EVENT_FILTERS.map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setFilter(value)}
                className={cn(
                  "border px-2 py-1 text-[9px] font-black uppercase tracking-[0.14em]",
                  filter === value
                    ? "border-[#b91c1c] bg-[#1c0808] text-[#fca5a5]"
                    : "border-[#262a31] text-zinc-500 hover:text-zinc-300",
                )}
              >
                {label}
              </button>
            ))}
          </div>
        }
      />
      <div className={cn(SEC.panel, "mb-4")}>
        <div className="flex items-center justify-between border-b border-[#1f232a] px-3 py-2">
          <p className="text-[9px] font-black uppercase tracking-[0.18em] text-zinc-500">
            Recent authentication attempts
          </p>
          <span className="font-mono text-[9px] text-zinc-700">security + KMC sign-in</span>
        </div>
        {attempts === undefined ? (
          <p className="px-3 py-3 text-[10px] uppercase tracking-[0.16em] text-zinc-600">Loading attempts…</p>
        ) : attempts.length === 0 ? (
          <p className="px-3 py-3 text-[11px] text-zinc-600">No authentication attempts recorded yet.</p>
        ) : (
          <ul className="divide-y divide-[#15181d]">
            {attempts.map((a) => (
              <li key={a._id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                <SecBadge tone={a.outcome === "SUCCESS" ? "ok" : "danger"}>
                  {a.outcome}
                </SecBadge>
                <span className="text-[10px] font-black uppercase tracking-[0.12em] text-zinc-400">
                  {a.kind.replace(/_/g, " ")}
                </span>
                <span className="min-w-0 flex-1 truncate text-[10px] text-zinc-500">
                  {a.detail ?? a.operatorId ?? "—"}
                </span>
                <span className="text-[9px] uppercase tracking-[0.12em] text-zinc-700">{a.ip ?? "no ip"}</span>
                <span className="text-[9px] text-zinc-600">{fmtDateTime(a.at)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {events === undefined ? (
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-zinc-600"><Loader2 className="size-4 animate-spin" /> Loading events</div>
      ) : events.length === 0 ? (
        <SecEmpty>No events for this filter</SecEmpty>
      ) : (
        <ul className="space-y-1.5">
          {events.map((e) => (
            <li key={e._id} className={cn(SEC.panelSoft, "flex flex-col gap-2 p-3 sm:flex-row sm:items-center")}>
              <div className="flex w-full items-center gap-2 sm:w-auto">
                <SecBadge tone={eventTone(e.kind)}>{e.kind.replace(/_/g, " ")}</SecBadge>
                <span className="font-mono text-[9px] text-zinc-600">{e.ref}</span>
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[11px] text-zinc-300">
                  {e.staffName} <span className="text-zinc-600">· {e.staffId ?? "—"}</span>
                </p>
                <p className="text-[10px] text-zinc-500">{e.detail}</p>
              </div>
              <div className="flex items-center gap-3 text-[9px] uppercase tracking-[0.12em] text-zinc-600">
                <span className="flex items-center gap-1"><Fingerprint className="size-3" />{e.deviceKey.slice(0, 10)}</span>
                <span>{e.ip ?? "no ip"}</span>
                <span>{fmtDateTime(e.at)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* -------------------------------- incidents ------------------------------- */

function IncidentsModule({ token }: { token: string }) {
  const incidents = useQuery(api.security.incidents, { token });
  const openIncident = useMutation(api.security.openIncident);
  const addNote = useMutation(api.security.addIncidentNote);
  const setStatus = useMutation(api.security.setIncidentStatus);
  const [openForm, setOpenForm] = useState(false);
  const [form, setForm] = useState({ title: "", severity: "MEDIUM", summary: "" });
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed.");
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <ModuleHeader
        eyebrow="Emergency security"
        title="Security incidents"
        description="Investigate unauthorized access, document containment and keep an auditable record of the response."
        right={
          <button type="button" onClick={() => setOpenForm(true)} className={cn(SEC.button, SEC.primary)}>
            <Plus className="size-3" /> Open incident
          </button>
        }
      />
      <ErrorBar error={error} />
      <SecModal open={openForm} title="Open security incident" subtitle="Recorded in the append-only audit chain." onClose={() => setOpenForm(false)}>
        <div className="space-y-3">
          <SecField label="Title">
            <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} className={SEC.input} />
          </SecField>
          <SecField label="Severity">
            <select value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value })} className={SEC.input}>
              {["LOW", "MEDIUM", "HIGH", "CRITICAL"].map((s) => <option key={s}>{s}</option>)}
            </select>
          </SecField>
          <SecField label="Summary">
            <textarea rows={3} value={form.summary} onChange={(e) => setForm({ ...form, summary: e.target.value })} className={SEC.input} />
          </SecField>
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              const ok = await run(() => openIncident({ token, ...form }));
              if (ok) {
                setOpenForm(false);
                setForm({ title: "", severity: "MEDIUM", summary: "" });
              }
            }}
            className={cn(SEC.button, SEC.primary, "w-full")}
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <ShieldAlert className="size-3.5" />} Log incident
          </button>
        </div>
      </SecModal>

      {incidents === undefined ? (
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-zinc-600"><Loader2 className="size-4 animate-spin" /> Loading incidents</div>
      ) : incidents.length === 0 ? (
        <SecEmpty>No security incidents recorded</SecEmpty>
      ) : (
        <div className="space-y-3">
          {incidents.map((i) => (
            <article key={i._id} className={cn(SEC.panel, "p-4")}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <SecBadge tone={statusTone(i.severity)}>{i.severity}</SecBadge>
                    <SecBadge tone={statusTone(i.status)}>{i.status}</SecBadge>
                    <span className="font-mono text-[9px] text-zinc-600">{i.ref}</span>
                  </div>
                  <h3 className="mt-2 text-[13px] font-bold text-zinc-100">{i.title}</h3>
                  <p className="mt-1 text-[11px] text-zinc-500">{i.summary}</p>
                  <p className="mt-1 text-[9px] uppercase tracking-[0.14em] text-zinc-600">
                    Opened by {i.openedBy} · {fmtDateTime(i.openedAt)}
                    {i.staffName ? ` · ${i.staffName} (${i.staffId ?? "—"})` : ""}
                  </p>
                </div>
                <div className="flex flex-wrap gap-1">
                  {["INVESTIGATING", "CONTAINED", "CLOSED"].map((s) => (
                    <button
                      key={s}
                      type="button"
                      disabled={busy || i.status === s}
                      onClick={() => void run(() => setStatus({ token, incidentId: i._id, status: s }))}
                      className={cn(SEC.button, SEC.ghost, "px-2 py-1")}
                    >
                      {s.toLowerCase()}
                    </button>
                  ))}
                  <button type="button" onClick={() => { setNoteFor(i._id); setNote(""); }} className={cn(SEC.button, SEC.ghost, "px-2 py-1")}>
                    Add note
                  </button>
                </div>
              </div>
              {i.notes.length > 0 ? (
                <ul className="mt-3 space-y-1.5 border-t border-[#1c1f25] pt-2">
                  {i.notes.map((n, idx) => (
                    <li key={idx} className="text-[10px] text-zinc-400">
                      <span className="text-zinc-600">{fmtDateTime(n.at)} · {n.operatorId}: </span>
                      {n.body}
                    </li>
                  ))}
                </ul>
              ) : null}
              {noteFor === i._id ? (
                <div className="mt-2 flex gap-2">
                  <input value={note} onChange={(e) => setNote(e.target.value)} className={SEC.input} placeholder="Investigation note" />
                  <button
                    type="button"
                    disabled={busy || note.trim().length < 3}
                    onClick={async () => {
                      const ok = await run(() => addNote({ token, incidentId: i._id, body: note }));
                      if (ok) setNoteFor(null);
                    }}
                    className={cn(SEC.button, SEC.primary, "shrink-0")}
                  >
                    Save
                  </button>
                </div>
              ) : null}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

/* -------------------------------- operators ------------------------------- */

function OperatorsModule({ token, session }: { token: string; session: SecSession }) {
  const operators = useQuery(api.security.operators, { token });
  const createOperator = useMutation(api.security.createOperator);
  const updateOperator = useMutation(api.security.updateOperator);
  const resetCredential = useMutation(api.security.resetOperatorCredential);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editTarget, setEditTarget] = useState<string | null>(null);
  const [resetTarget, setResetTarget] = useState<string | null>(null);
  const [form, setForm] = useState({
    operatorId: "",
    name: "",
    role: "SECURITY_OFFICER",
    credential: "",
    confirmCredential: "",
    confirmOperatorCredential: "",
  });
  const [editForm, setEditForm] = useState({
    name: "",
    role: "SECURITY_OFFICER",
    status: "ACTIVE",
    permissions: [] as string[],
    confirmOperatorCredential: "",
  });
  const [resetForm, setResetForm] = useState({
    credential: "",
    confirmCredential: "",
    confirmOperatorCredential: "",
  });

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed.");
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <ModuleHeader
        eyebrow="Security configuration"
        title="Security operators"
        description="Separate identities with their own credentials and permissions. They are not KMC staff accounts and no SUPER_ADMIN operation can create or modify them."
        right={
          <button type="button" onClick={() => setCreating(true)} className={cn(SEC.button, SEC.primary)}>
            <UserCog className="size-3" /> New operator
          </button>
        }
      />
      <ErrorBar error={error} />
      {operators === undefined ? (
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-zinc-600"><Loader2 className="size-4 animate-spin" /> Loading operators</div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {operators.map((o) => (
            <article key={o.operatorId} className={cn(SEC.panel, "p-4")}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-[#f87171]">{o.operatorId}</p>
                  <h3 className="mt-1 text-[13px] font-bold text-zinc-100">{o.name}</h3>
                  <p className="text-[10px] text-zinc-500">
                    {SECURITY_ROLE_LABELS[o.role as SecurityRole] ?? o.role}
                  </p>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <SecBadge tone={statusTone(o.status)}>{o.status}</SecBadge>
                  {o.mustRotateCredential ? <SecBadge tone="warn">rotation due</SecBadge> : null}
                  {o.operatorId === session.operator?.operatorId ? <SecBadge tone="info">you</SecBadge> : null}
                </div>
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-2 text-[10px] text-zinc-500">
                <div><dt className="uppercase tracking-[0.14em] text-zinc-600">Permissions</dt><dd>{o.permissions.length} of {SECURITY_PERMISSIONS.length}</dd></div>
                <div><dt className="uppercase tracking-[0.14em] text-zinc-600">Last login</dt><dd>{fmtDateTime(o.lastLoginAt)}</dd></div>
                <div><dt className="uppercase tracking-[0.14em] text-zinc-600">Created</dt><dd>{fmtDateTime(o.createdAt)}</dd></div>
                <div><dt className="uppercase tracking-[0.14em] text-zinc-600">Created by</dt><dd>{o.createdBy}</dd></div>
              </dl>
              <div className="mt-3 flex gap-1">
                <button
                  type="button"
                  onClick={() => {
                    setEditTarget(o.operatorId);
                    setEditForm({
                      name: o.name,
                      role: o.role,
                      status: o.status,
                      permissions: o.permissions,
                      confirmOperatorCredential: "",
                    });
                    setError(null);
                  }}
                  className={cn(SEC.button, SEC.ghost, "px-2 py-1")}
                >
                  Permissions
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setResetTarget(o.operatorId);
                    setResetForm({ credential: "", confirmCredential: "", confirmOperatorCredential: "" });
                    setError(null);
                  }}
                  className={cn(SEC.button, SEC.ghost, "px-2 py-1")}
                >
                  <KeyRound className="size-3" /> Reset credential
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      <SecModal open={creating} title="Create security operator" subtitle="No self-registration exists — operators are created here only." onClose={() => setCreating(false)}>
        <ErrorBar error={error} />
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <SecField label="Operator ID"><input value={form.operatorId} onChange={(e) => setForm({ ...form, operatorId: e.target.value.toUpperCase() })} className={cn(SEC.input, "font-mono")} placeholder="SO-0002" /></SecField>
            <SecField label="Name"><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={SEC.input} /></SecField>
            <SecField label="Role">
              <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} className={SEC.input}>
                {SECURITY_ROLES.map((r) => <option key={r} value={r}>{SECURITY_ROLE_LABELS[r]}</option>)}
              </select>
            </SecField>
            <SecField label="Initial credential" hint="Must be rotated at first sign-in."><input type="password" value={form.credential} onChange={(e) => setForm({ ...form, credential: e.target.value })} className={SEC.input} autoComplete="new-password" /></SecField>
            <SecField label="Confirm credential"><input type="password" value={form.confirmCredential} onChange={(e) => setForm({ ...form, confirmCredential: e.target.value })} className={SEC.input} autoComplete="new-password" /></SecField>
            <SecField label="Your credential" hint="Additional verification."><input type="password" value={form.confirmOperatorCredential} onChange={(e) => setForm({ ...form, confirmOperatorCredential: e.target.value })} className={SEC.input} autoComplete="current-password" /></SecField>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              const ok = await run(() => createOperator({ token, ...form }));
              if (ok) {
                setCreating(false);
                setForm({ operatorId: "", name: "", role: "SECURITY_OFFICER", credential: "", confirmCredential: "", confirmOperatorCredential: "" });
              }
            }}
            className={cn(SEC.button, SEC.primary, "w-full")}
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />} Create operator
          </button>
        </div>
      </SecModal>

      <SecModal open={!!editTarget} title={`Permissions · ${editTarget ?? ""}`} subtitle="Role presets can be overridden per permission. Changes invalidate the operator's sessions." onClose={() => setEditTarget(null)}>
        <ErrorBar error={error} />
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <SecField label="Name"><input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} className={SEC.input} /></SecField>
            <SecField label="Status">
              <select value={editForm.status} onChange={(e) => setEditForm({ ...editForm, status: e.target.value })} className={SEC.input}>
                {["ACTIVE", "SUSPENDED", "DISABLED"].map((s) => <option key={s}>{s}</option>)}
              </select>
            </SecField>
          </div>
          <div>
            <p className={SEC.label}>Permissions</p>
            <div className="mt-1.5 grid gap-1.5">
              {SECURITY_PERMISSIONS.map((p) => (
                <label key={p} className="flex items-start gap-2 border border-[#22262d] bg-[#0a0c0f] px-2 py-1.5">
                  <input
                    type="checkbox"
                    checked={editForm.permissions.includes(p)}
                    onChange={(e) =>
                      setEditForm({
                        ...editForm,
                        permissions: e.target.checked
                          ? [...editForm.permissions, p]
                          : editForm.permissions.filter((x) => x !== p),
                      })
                    }
                    className="mt-0.5 accent-[#b91c1c]"
                  />
                  <span>
                    <span className="block font-mono text-[10px] text-zinc-300">{p}</span>
                    <span className="block text-[10px] text-zinc-600">{SECURITY_PERMISSION_LABELS[p as SecurityPermission]}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>
          <SecField label="Your credential" hint="Additional verification."><input type="password" value={editForm.confirmOperatorCredential} onChange={(e) => setEditForm({ ...editForm, confirmOperatorCredential: e.target.value })} className={SEC.input} /></SecField>
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              if (!editTarget) return;
              const ok = await run(() =>
                updateOperator({
                  token,
                  operatorId: editTarget,
                  name: editForm.name,
                  role: editForm.role,
                  status: editForm.status,
                  permissions: editForm.permissions,
                  confirmOperatorCredential: editForm.confirmOperatorCredential,
                }),
              );
              if (ok) setEditTarget(null);
            }}
            className={cn(SEC.button, SEC.primary, "w-full")}
          >
            Save operator
          </button>
        </div>
      </SecModal>

      <SecModal open={!!resetTarget} title={`Reset credential · ${resetTarget ?? ""}`} subtitle="The operator must set a new credential at next sign-in. All their sessions are revoked." onClose={() => setResetTarget(null)}>
        <ErrorBar error={error} />
        <div className="space-y-3">
          <SecField label="Temporary credential"><input type="password" value={resetForm.credential} onChange={(e) => setResetForm({ ...resetForm, credential: e.target.value })} className={SEC.input} autoComplete="new-password" /></SecField>
          <SecField label="Confirm temporary credential"><input type="password" value={resetForm.confirmCredential} onChange={(e) => setResetForm({ ...resetForm, confirmCredential: e.target.value })} className={SEC.input} autoComplete="new-password" /></SecField>
          <SecField label="Your credential" hint="Additional verification."><input type="password" value={resetForm.confirmOperatorCredential} onChange={(e) => setResetForm({ ...resetForm, confirmOperatorCredential: e.target.value })} className={SEC.input} /></SecField>
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              if (!resetTarget) return;
              const ok = await run(() => resetCredential({ token, operatorId: resetTarget, ...resetForm }));
              if (ok) setResetTarget(null);
            }}
            className={cn(SEC.button, SEC.danger, "w-full")}
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <KeyRound className="size-3.5" />} Reset credential
          </button>
        </div>
      </SecModal>
    </div>
  );
}

/* ---------------------------------- audit --------------------------------- */

function AuditModule({ token }: { token: string }) {
  const data = useQuery(api.security.auditLog, { token, limit: 200 });
  return (
    <div>
      <ModuleHeader
        eyebrow="Security monitoring"
        title="Audit history"
        description="Append-only records written by the security backend. Each entry commits to the previous hash, so removal or editing is detectable. No delete or edit endpoint exists."
        right={
          data ? (
            <SecBadge tone={data.integrity.ok ? "ok" : "danger"}>
              <ShieldCheck className="size-2.5" />
              {data.integrity.ok
                ? `chain verified · ${data.integrity.checked} entries`
                : `integrity break at ${data.integrity.firstBrokenRef}`}
            </SecBadge>
          ) : null
        }
      />
      {!data ? (
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-zinc-600"><Loader2 className="size-4 animate-spin" /> Verifying audit chain</div>
      ) : data.entries.length === 0 ? (
        <SecEmpty>No audit entries recorded</SecEmpty>
      ) : (
        <div className="overflow-x-auto border border-[#1f232a]">
          <table className="w-full min-w-[1020px] border-collapse text-left">
            <thead>
              <tr className="bg-[#0b0d10] text-[9px] uppercase tracking-[0.16em] text-zinc-500">
                {["Ref", "Action", "Operator", "Target", "Previous", "New", "Reason", "At", "Hash"].map((h) => (
                  <th key={h} className="border-b border-[#1f232a] px-3 py-2 font-black">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.entries.map((a) => (
                <tr key={a._id} className="border-b border-[#15181d] align-top hover:bg-[#0c0e12]">
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-[10px] text-zinc-500">{a.ref}</td>
                  <td className="px-3 py-2"><SecBadge tone={eventTone(a.action)}>{a.action.replace(/_/g, " ")}</SecBadge></td>
                  <td className="px-3 py-2">
                    <p className="text-[10px] text-zinc-300">{a.operatorName}</p>
                    <p className="font-mono text-[9px] text-zinc-600">{a.operatorId}</p>
                  </td>
                  <td className="px-3 py-2 text-[10px] text-zinc-400">
                    {a.targetType}
                    <p className="font-mono text-[9px] text-zinc-600">{a.targetId}</p>
                  </td>
                  <td className="max-w-[180px] truncate px-3 py-2 font-mono text-[9px] text-zinc-600" title={a.previousState}>{a.previousState || "—"}</td>
                  <td className="max-w-[180px] truncate px-3 py-2 font-mono text-[9px] text-zinc-500" title={a.newState}>{a.newState || "—"}</td>
                  <td className="max-w-[200px] px-3 py-2 text-[10px] text-zinc-500">{a.reason || "—"}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-[9px] text-zinc-600">{fmtDateTime(a.at)}<br />{a.ip}</td>
                  <td className="px-3 py-2 font-mono text-[9px] text-zinc-700" title={a.hash}>{a.hash.slice(0, 10)}…</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* -------------------------------- settings -------------------------------- */

function SettingsModule({ token, session }: { token: string; session: SecSession }) {
  const changePin = useMutation(api.security.changePin);
  const rotateRecovery = useMutation(api.security.rotateRecoveryCode);
  const updatePolicy = useMutation(api.security.updateSessionPolicy);
  const [pinForm, setPinForm] = useState({ currentPin: "", newPin: "", confirmPin: "" });
  const [policy, setPolicy] = useState(String(session.sessionPolicyMinutes));
  const [credential, setCredential] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);

  const run = async (fn: () => Promise<string | null>) => {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const message = await fn();
      if (message) setInfo(message);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed.");
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <ModuleHeader
        eyebrow="Security configuration"
        title="Portal configuration"
        description="PIN rotation, recovery credential and session policy. Only operators holding security.credentials.rotate or security.settings.update can change these — SUPER_ADMIN cannot."
      />
      <ErrorBar error={error} />
      {info ? <p className="mb-3 border border-emerald-900/60 bg-emerald-950/30 px-3 py-2 text-[11px] text-emerald-300">{info}</p> : null}
      {recoveryCode ? (
        <div className="mb-4 border border-[#b91c1c]/50 bg-[#120708] p-4">
          <p className={SEC.label}>New recovery code — shown once</p>
          <pre className="mt-2 select-all text-center font-mono text-lg tracking-[0.18em] text-[#fecaca]">{recoveryCode}</pre>
          <button type="button" onClick={() => setRecoveryCode(null)} className={cn(SEC.button, SEC.ghost, "mt-3 w-full")}>I have stored it</button>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <section className={cn(SEC.panel, "p-4")}>
          <p className={SEC.heading}>Department PIN</p>
          <p className="mt-1 text-[11px] text-zinc-500">
            6 digits, no sequences or repeats. Rotating the PIN revokes every security session.
          </p>
          <div className="mt-3 space-y-3">
            <SecField label="Current PIN"><input type="password" inputMode="numeric" value={pinForm.currentPin} onChange={(e) => setPinForm({ ...pinForm, currentPin: e.target.value.replace(/\D/g, "").slice(0, 6) })} className={SEC.input} autoComplete="off" /></SecField>
            <div className="grid gap-3 sm:grid-cols-2">
              <SecField label="New PIN"><input type="password" inputMode="numeric" value={pinForm.newPin} onChange={(e) => setPinForm({ ...pinForm, newPin: e.target.value.replace(/\D/g, "").slice(0, 6) })} className={SEC.input} autoComplete="new-password" /></SecField>
              <SecField label="Confirm PIN"><input type="password" inputMode="numeric" value={pinForm.confirmPin} onChange={(e) => setPinForm({ ...pinForm, confirmPin: e.target.value.replace(/\D/g, "").slice(0, 6) })} className={SEC.input} autoComplete="new-password" /></SecField>
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(async () => {
                await changePin({ token, ...pinForm });
                setPinForm({ currentPin: "", newPin: "", confirmPin: "" });
                return "Department PIN rotated. All other security sessions were revoked.";
              })}
              className={cn(SEC.button, SEC.primary, "w-full")}
            >
              <Lock className="size-3.5" /> Rotate PIN
            </button>
          </div>
        </section>

        <section className={cn(SEC.panel, "p-4")}>
          <p className={SEC.heading}>Recovery &amp; session policy</p>
          <p className="mt-1 text-[11px] text-zinc-500">
            Recovery uses a code issued at activation, not the activation PIN. It is stored as a PBKDF2 hash only.
          </p>
          <div className="mt-3 space-y-3">
            <SecField label="Session idle timeout (minutes)" hint="5–480. Applies to new and current sessions.">
              <input inputMode="numeric" value={policy} onChange={(e) => setPolicy(e.target.value.replace(/\D/g, "").slice(0, 3))} className={SEC.input} />
            </SecField>
            <SecField label="Your credential" hint="Required for both actions below.">
              <input type="password" value={credential} onChange={(e) => setCredential(e.target.value)} className={SEC.input} autoComplete="current-password" />
            </SecField>
            <div className="flex flex-col gap-2 sm:flex-row">
              <button
                type="button"
                disabled={busy || !credential}
                onClick={() => void run(async () => {
                  await updatePolicy({ token, minutes: Number(policy), confirmOperatorCredential: credential });
                  return "Session policy updated.";
                })}
                className={cn(SEC.button, SEC.primary, "flex-1")}
              >
                Save policy
              </button>
              <button
                type="button"
                disabled={busy || !credential}
                onClick={() => void run(async () => {
                  const result = await rotateRecovery({ token, confirmOperatorCredential: credential });
                  setRecoveryCode(result.recoveryCode);
                  return null;
                })}
                className={cn(SEC.button, SEC.ghost, "flex-1")}
              >
                <RefreshCcw className="size-3.5" /> Rotate recovery code
              </button>
            </div>
          </div>
        </section>
      </div>

      <section className={cn(SEC.panelSoft, "mt-4 p-4")}>
        <p className={SEC.heading}>Infrastructure &amp; trust boundary</p>
        <ul className="mt-2 space-y-1.5 text-[10px] leading-relaxed text-zinc-500">
          <li>• Security identities, sessions, device registry and audit rows live in dedicated tables in the same Convex deployment; no staff query or mutation can read or write them.</li>
          <li>• Authorization is server-side: a Security Operator bearer token plus the permission list on the operator row. SUPER_ADMIN JWT / role values are never consulted here.</li>
          <li>• Deployment owners (Convex project owners) can still change functions, schema and environment variables. Complete infrastructure independence requires a separate Convex deployment with separate owner credentials.</li>
        </ul>
      </section>
    </div>
  );
}
