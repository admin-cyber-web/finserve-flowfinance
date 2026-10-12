import { cn } from "@/lib/utils";
import { formatINR } from "@/lib/finance/money";
import { STATUS_TONES, type Tone } from "@/lib/finance/types";
import { ArrowLeft, CheckCircle2, Inbox, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useEffect, useState } from "react";

/* --------------------------------- Brand --------------------------------- */

export function Logo({
  className,
  withWordmark = true,
}: {
  className?: string;
  withWordmark?: boolean;
}) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <span className="grid size-9 place-items-center border-2 border-ink bg-gold font-black text-ink shadow-hard-sm">
        ₹
      </span>
      {withWordmark && (
        <span className="leading-none tracking-tight">
          <span className="block text-base font-black">KIRAT</span>
          <span className="block text-[10px] font-black uppercase tracking-[0.22em]">
            Micro Credit
          </span>
        </span>
      )}
    </span>
  );
}

/* --------------------------------- Money --------------------------------- */

export function Money({
  value,
  className,
  paise = false,
  signed = false,
}: {
  value: number;
  className?: string;
  paise?: boolean;
  signed?: boolean;
}) {
  const prefix = signed && value > 0 ? "+" : "";
  return (
    <span className={cn("font-black tabular-nums tracking-tight", className)}>
      {prefix}
      {formatINR(value, { paise })}
    </span>
  );
}

/* ------------------------------- Status chip ------------------------------ */

const TONE_CLASS: Record<Tone, string> = {
  ok: "bg-mint",
  warn: "bg-gold",
  bad: "bg-blush",
  info: "bg-sky",
  idle: "bg-clay",
  hot: "bg-royal text-white",
};

export function toneFor(status: string): Tone {
  return STATUS_TONES[status] ?? "idle";
}

export function StatusChip({
  status,
  label,
  tone,
  className,
}: {
  status?: string;
  label?: string;
  tone?: Tone;
  className?: string;
}) {
  const resolved = tone ?? (status ? toneFor(status) : "idle");
  return (
    <span
      className={cn(
        "inline-flex w-fit items-center border-2 border-ink px-1.5 py-0.5 text-[10px] font-black uppercase leading-none tracking-wider",
        TONE_CLASS[resolved],
        className,
      )}
    >
      {label ?? (status ? status.replace(/_/g, " ") : "")}
    </span>
  );
}

/* -------------------------------- Layout bits ----------------------------- */

export function SectionTitle({
  children,
  action,
  className,
}: {
  children: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-2 flex items-center justify-between gap-3", className)}>
      <h2 className="text-xs font-black uppercase tracking-[0.14em] text-muted-foreground">
        {children}
      </h2>
      {action}
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  back,
  action,
}: {
  title: string;
  subtitle?: string;
  back?: string | boolean;
  action?: ReactNode;
}) {
  const navigate = useNavigate();
  return (
    <div className="mb-4 flex items-start gap-3">
      {back && (
        <Button
          variant="outline"
          size="icon-sm"
          className="mt-0.5 shrink-0"
          aria-label="Back"
          onClick={() => (typeof back === "string" ? navigate(back) : navigate(-1))}
        >
          <ArrowLeft />
        </Button>
      )}
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-xl font-black leading-tight tracking-tight">
          {title}
        </h1>
        {subtitle && (
          <p className="truncate text-xs font-semibold text-muted-foreground">
            {subtitle}
          </p>
        )}
      </div>
      {action}
    </div>
  );
}

export function StatCard({
  label,
  value,
  sub,
  tone = "idle",
  onClick,
  className,
}: {
  label: string;
  value: ReactNode;
  sub?: string;
  tone?: Tone;
  onClick?: () => void;
  className?: string;
}) {
  const Comp = onClick ? "button" : "div";
  return (
    <Comp
      onClick={onClick}
      className={cn(
        "border-2 border-ink bg-card p-3 text-left shadow-hard-sm transition-transform",
        onClick && "hover:-translate-y-0.5 active:translate-y-0",
        TONE_CLASS[tone === "idle" ? "idle" : tone],
        tone === "idle" && "bg-card",
        className,
      )}
    >
      <div className="text-[10px] font-black uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-lg font-black leading-none tracking-tight">
        {value}
      </div>
      {sub && (
        <div className="mt-1 text-[11px] font-semibold text-muted-foreground">
          {sub}
        </div>
      )}
    </Comp>
  );
}

/* ------------------------------ States ----------------------------------- */

export function EmptyState({
  title,
  hint,
  action,
  icon,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 border-2 border-dashed border-ink/50 bg-card/60 px-6 py-10 text-center">
      <div className="grid size-12 place-items-center border-2 border-ink bg-clay">
        {icon ?? <Inbox className="size-5" />}
      </div>
      <p className="text-sm font-black uppercase tracking-wide">{title}</p>
      {hint && <p className="max-w-xs text-xs font-medium text-muted-foreground">{hint}</p>}
      {action}
    </div>
  );
}

export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="flex items-start gap-3 border-2 border-ink bg-blush p-4 shadow-hard-sm">
      <TriangleAlert className="mt-0.5 size-5 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-black uppercase">Something went wrong</p>
        <p className="mt-1 break-words text-xs font-semibold">{message}</p>
      </div>
      {onRetry && (
        <Button size="sm" variant="outline" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

export function RowSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-2" aria-busy>
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="h-16 animate-pulse-block border-2 border-ink bg-muted"
        />
      ))}
    </div>
  );
}

/* ------------------------------ Money input ------------------------------ */

/** Big, keypad-friendly ₹ input with quick amount chips. */
export function MoneyInput({
  value,
  onChange,
  quick = [],
  autoFocus = false,
  label = "Amount",
  min,
}: {
  value: string;
  onChange: (v: string) => void;
  quick?: number[];
  autoFocus?: boolean;
  label?: string;
  min?: number;
}) {
  return (
    <div className="space-y-2">
      <Label className="text-xs font-black uppercase tracking-wider">{label}</Label>
      <div className="flex items-center border-2 border-ink bg-white shadow-hard-sm">
        <span className="grid h-14 w-12 place-items-center border-r-2 border-ink bg-gold text-2xl font-black">
          ₹
        </span>
        <input
          inputMode="numeric"
          autoFocus={autoFocus}
          value={value}
          onChange={(e) => onChange(e.target.value.replace(/[^\d]/g, ""))}
          placeholder="0"
          className="h-14 w-full bg-transparent px-3 text-3xl font-black tabular-nums outline-none"
        />
      </div>
      {quick.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {quick.map((amt) => (
            <button
              key={amt}
              type="button"
              onClick={() => onChange(String(amt))}
              className="border-2 border-ink bg-white px-2.5 py-1 text-xs font-black shadow-hard-sm active:translate-x-[2px] active:translate-y-[2px] active:shadow-none"
            >
              {formatINR(amt)}
            </button>
          ))}
          {min !== undefined && Number(value || 0) < min && (
            <span className="w-full text-xs font-bold text-destructive">
              Minimum {formatINR(min)}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------------------------- Confirm dialog ----------------------------- */

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "default",
  loading = false,
  onConfirm,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "default" | "danger";
  loading?: boolean;
  onConfirm: () => void;
  children?: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm border-2 border-ink bg-card shadow-hard">
        <DialogHeader>
          <DialogTitle className="text-lg font-black uppercase tracking-tight">
            {title}
          </DialogTitle>
          {message && (
            <DialogDescription className="text-sm font-semibold">
              {message}
            </DialogDescription>
          )}
        </DialogHeader>
        {children}
        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={loading}
          >
            {cancelLabel}
          </Button>
          <Button
            variant={tone === "danger" ? "destructive" : "default"}
            onClick={onConfirm}
            disabled={loading}
          >
            {loading ? "Working…" : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ----------------------------- Bottom sheet ------------------------------ */

/** Mobile-first sheet that slides from the bottom with a grab handle. */
export function BottomSheet({
  open,
  onOpenChange,
  title,
  subtitle,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="fixed inset-x-0 bottom-0 top-auto max-w-[480px] translate-y-0 gap-0 border-x-0 border-b-0 border-t-2 border-ink bg-card p-0 shadow-none data-[state=open]:slide-in-from-bottom-full sm:left-1/2 sm:right-auto sm:-translate-x-1/2 sm:border-x-2 sm:border-b-2">
        <div className="mx-auto mt-2 h-1.5 w-12 border-2 border-ink bg-gold" />
        <DialogHeader className="border-b-2 border-ink px-4 py-3 text-left">
          <DialogTitle className="text-base font-black uppercase tracking-tight">
            {title}
          </DialogTitle>
          {subtitle && (
            <DialogDescription className="text-xs font-semibold">
              {subtitle}
            </DialogDescription>
          )}
        </DialogHeader>
        <div className="max-h-[70vh] overflow-y-auto px-4 py-4">{children}</div>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------ Inline row -------------------------------- */

export function KeyValue({
  k,
  v,
  mono = false,
}: {
  k: string;
  v: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-ink/15 py-2 last:border-0">
      <span className="text-xs font-bold uppercase tracking-wide text-muted-foreground">
        {k}
      </span>
      <span
        className={cn(
          "text-right text-sm font-black",
          mono && "font-mono tabular-nums",
        )}
      >
        {v}
      </span>
    </div>
  );
}

/* ------------------------------ Copy field -------------------------------- */

export function CopyableCode({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(value).catch(() => undefined);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      className="inline-flex items-center gap-1 border-2 border-ink bg-clay px-2 py-1 font-mono text-xs font-bold"
    >
      {value}
      {copied && <CheckCircle2 className="size-3 text-success" />}
    </button>
  );
}

/** Formats a date consistently across the app (IST display). */
export function formatDate(ts?: number | null): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export function formatDateTime(ts?: number | null): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatDate(ts);
}

/* ---------------------------- Loading button ------------------------------ */

export function useBusy() {
  const [busy, setBusy] = useState(false);
  const run = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    try {
      return await fn();
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}

/** Small helper for local-date key inputs (YYYY-MM-DD in IST). */
export function todayInputValue(): string {
  return new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
}

export { Input as TextInput };
