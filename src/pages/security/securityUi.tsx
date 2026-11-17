/**
 * Visual primitives for the Security Department command center.
 *
 * Hard-coded deep-black / charcoal / dark-red palette on purpose: this portal
 * must not look like (or inherit) the KMC staff dashboard theme.
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export const SEC = {
  page: "min-h-screen bg-[#060709] text-zinc-200",
  panel:
    "border border-[#23262d] bg-[#0e1013] shadow-[0_1px_0_0_#1b1e24_inset]",
  panelSoft: "border border-[#1d2026] bg-[#0b0d10]",
  heading:
    "text-[11px] font-black uppercase tracking-[0.22em] text-zinc-500",
  label: "text-[10px] font-bold uppercase tracking-[0.18em] text-zinc-500",
  input:
    "w-full rounded-sm border border-[#2a2e36] bg-[#08090b] px-3 py-2.5 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-[#b91c1c] focus:ring-1 focus:ring-[#b91c1c]/40",
  button:
    "inline-flex items-center justify-center gap-2 rounded-sm border px-3.5 py-2 text-[11px] font-black uppercase tracking-[0.14em] transition disabled:cursor-not-allowed disabled:opacity-40",
  danger:
    "border-[#b91c1c]/60 bg-[#b91c1c]/12 text-[#fca5a5] hover:bg-[#b91c1c]/22 hover:text-[#fecaca]",
  primary:
    "border-[#dc2626] bg-[#b91c1c] text-white hover:bg-[#dc2626] shadow-[0_0_28px_-10px_#dc2626]",
  ghost:
    "border-[#2a2e36] bg-transparent text-zinc-300 hover:border-[#3d434d] hover:text-zinc-100",
  mono: "font-mono text-[11px] tracking-tight",
} as const;

export function SecBadge({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: "neutral" | "ok" | "warn" | "danger" | "info" | "muted";
  className?: string;
}) {
  const tones: Record<string, string> = {
    neutral: "border-[#333842] bg-[#15181d] text-zinc-300",
    ok: "border-emerald-800/70 bg-emerald-950/50 text-emerald-300",
    warn: "border-amber-800/70 bg-amber-950/40 text-amber-300",
    danger: "border-[#b91c1c]/70 bg-[#2a0b0b] text-[#fca5a5]",
    info: "border-sky-900/70 bg-sky-950/40 text-sky-300",
    muted: "border-[#24272e] bg-[#0b0d10] text-zinc-500",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 border px-1.5 py-0.5 text-[9px] font-black uppercase tracking-[0.14em]",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function statusTone(
  status: string,
): "ok" | "warn" | "danger" | "muted" | "info" {
  switch (status.toUpperCase()) {
    case "AUTHORIZED":
    case "ACTIVE":
    case "CLOSED":
      return "ok";
    case "PENDING":
    case "OPEN":
    case "INVESTIGATING":
    case "SUSPENDED":
      return "warn";
    case "BLOCKED":
    case "REVOKED":
    case "REPLACED":
    case "DISABLED":
    case "CRITICAL":
    case "HIGH":
      return "danger";
    case "REJECTED":
      return "muted";
    default:
      return "info";
  }
}

export function SecStat({
  label,
  value,
  hint,
  tone = "neutral",
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: "neutral" | "danger" | "warn" | "ok";
}) {
  const accent: Record<string, string> = {
    neutral: "text-zinc-100",
    danger: "text-[#f87171]",
    warn: "text-amber-300",
    ok: "text-emerald-300",
  };
  return (
    <div className="relative overflow-hidden border border-[#23262d] bg-[#0e1013] p-4">
      <span className="absolute right-0 top-0 h-full w-[2px] bg-gradient-to-b from-transparent via-[#b91c1c]/50 to-transparent" />
      <p className={SEC.label}>{label}</p>
      <p className={cn("mt-2 text-3xl font-black tabular-nums", accent[tone])}>
        {value}
      </p>
      {hint ? (
        <p className="mt-1 text-[10px] uppercase tracking-[0.14em] text-zinc-600">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function SecModal({
  open,
  title,
  subtitle,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/80 p-0 backdrop-blur-sm sm:items-center sm:p-6">
      <div className="relative max-h-[92vh] w-full max-w-xl overflow-y-auto border border-[#2b2f37] bg-[#0b0d10] p-5 shadow-2xl">
        <div className="mb-4 flex items-start justify-between gap-4 border-b border-[#1e2128] pb-3">
          <div>
            <h3 className="text-sm font-black uppercase tracking-[0.16em] text-zinc-100">
              {title}
            </h3>
            {subtitle ? (
              <p className="mt-1 text-[11px] text-zinc-500">{subtitle}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="border border-[#2a2e36] px-2 py-1 text-[10px] font-bold uppercase tracking-widest text-zinc-400 hover:text-zinc-100"
          >
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function SecField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className={SEC.label}>{label}</span>
      <div className="mt-1.5">{children}</div>
      {hint ? <p className="mt-1 text-[10px] text-zinc-600">{hint}</p> : null}
    </label>
  );
}

export function fmtDateTime(value: number | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function fmtAgo(value: number | null | undefined): string {
  if (!value) return "—";
  const diff = Date.now() - value;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h ago`;
  return `${Math.floor(diff / 86_400_000)} d ago`;
}

export function SecEmpty({ children }: { children: ReactNode }) {
  return (
    <div className="border border-dashed border-[#24272e] bg-[#0a0c0f] px-4 py-10 text-center text-[11px] uppercase tracking-[0.16em] text-zinc-600">
      {children}
    </div>
  );
}

export function eventTone(kind: string) {
  if (kind.startsWith("UNAUTHORIZED")) return "danger" as const;
  if (kind.includes("BLOCKED") || kind.includes("REVOKED") || kind.includes("REPLACED"))
    return "danger" as const;
  if (kind.includes("APPROVED") || kind.includes("AUTHORIZED")) return "ok" as const;
  if (kind.includes("REQUESTED") || kind.includes("REJECTED")) return "warn" as const;
  return "info" as const;
}
