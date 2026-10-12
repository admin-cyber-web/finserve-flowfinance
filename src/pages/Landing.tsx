import { motion } from "framer-motion";
import { ArrowRight, Banknote, Building2, ClipboardList, CloudOff, History, IndianRupee, Lock, RefreshCw, Shield, Users } from "lucide-react";
import { Logo } from "@/components/fs/primitives";
import { Button } from "@/components/ui/button";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import type { ReactNode } from "react";

/* ---------------------------------------------------------------------------
 * KIRAT MICRO CREDIT — landing page
 * Premium saffron banking theme: square corners, 2px ink borders,
 * flat colour blocks (deep saffron / saffron / sand), hard offset shadows.
 * --------------------------------------------------------------------------- */

const SCROLL_ITEMS = [
  { label: "Wallet-led staff cash", value: "₹4,00,000 limit" },
  { label: "Loan ledger — no deletes", value: "Reversals only" },
  { label: "Collections with receipts", value: "RCPT-YYYYMMDD-NNNN" },
  { label: "Cash handover to branch", value: "Full money trail" },
  { label: "Offline field mode", value: "Idempotent sync" },
  { label: "Role-based access", value: "Admin · BM · Staff · Accountant" },
  { label: "Audit log of every action", value: "Who · what · when" },
  { label: "Demo workspace seeded", value: "ST10025 · ₹2,75,430" },
];

const FEATURES = [
  {
    icon: IndianRupee,
    title: "Loans & approvals",
    body: "Staff submit applications; BM/admin approve, then disburse against a flat or reducing schedule. Every rupee is ledger-backed.",
    tone: "bg-royal" as const,
  },
  {
    icon: Banknote,
    title: "Collections & receipts",
    body: "Record repayments against an active loan in cash, UPI, Cheque or Transfer. Each collection prints a receipt and hits the ledger.",
    tone: "bg-mint" as const,
  },
  {
    icon: Building2,
    title: "Cash management",
    body: "Day book, closing reconciliation, cash issues, expenses and handovers. Differences surface as alerts, never as silent edits.",
    tone: "bg-gold" as const,
  },
  {
    icon: Shield,
    title: "Ledger truth, no deletes",
    body: "Balances are derived, never typed. Corrections are reversals, not deletes. Audit logs capture the actor, role and timestamp.",
    tone: "bg-sky" as const,
  },
  {
    icon: CloudOff,
    title: "Offline field mode",
    body: "Field staff queue collections offline and replay them with idempotency keys when connectivity returns — payments survive the network.",
    tone: "bg-clay" as const,
  },
  {
    icon: Users,
    title: "Role-based access",
    body: "SUPER_ADMIN, BRANCH_MANAGER, FIELD_STAFF, ACCOUNTANT and CLIENT each see a shell built for their job — and only their branch.",
    tone: "bg-blush" as const,
  },
];

const MONEY_STATS = [
  { value: "₹4,00,000", label: "Max staff wallet limit", sub: "Working cash, derived balance" },
  { value: "₹2,75,430", label: "Outstanding portfolio", sub: "Across active + overdue loans" },
  { value: "21", label: "Active clients", sub: "Across the seeded branch" },
  { value: "12", label: "Staff profiles", sub: "Admin · BM · accountants · field" },
];

export default function Landing() {
  const navigate = useNavigate();
  const [scrollY, setScrollY] = useState(0);
  const rafRef = useRef<number | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const onScroll = () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        setScrollY(window.scrollY);
        rafRef.current = null;
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 30);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="relative min-h-screen bg-paper overflow-hidden">
      {/* Sticky wordmark */}
      <header className="sticky top-0 z-50 border-b-2 border-ink bg-card/95 px-4 py-3 backdrop-blur-sm sm:px-8">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4">
          <Logo />
          <nav className="hidden items-center gap-6 text-sm font-black uppercase tracking-widest sm:flex">
            <NavLink to="/auth" label="Sign in" />
          </nav>
          <Button
            size="sm"
            className="shadow-hard-sm uppercase"
            onClick={() => navigate("/auth")}
          >
            Sign in
            <ArrowRight className="ml-1.5 size-4" />
          </Button>
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden px-4 pt-14 pb-16 text-center sm:px-8 sm:pt-20 sm:pb-24">
        {/* Background block stack */}
        <div className="pointer-events-none absolute inset-0" aria-hidden>
          <div className="absolute left-0 top-0 h-48 w-48 border-2 border-ink bg-navy shadow-hard" />
          <div className="absolute right-0 top-12 h-24 w-24 border-2 border-ink bg-gold shadow-hard-sm" />
          <div className="absolute left-1/2 top-24 -translate-x-1/2 h-12 w-12 border-2 border-ink bg-royal shadow-hard-sm" />
          <div className="absolute bottom-0 right-1/4 h-32 w-32 border-2 border-ink bg-mint/60 shadow-hard" />
        </div>

        <BannerWrapper>
          <div className="relative mx-auto max-w-4xl">
            {/* Tag */}
            <div className="mx-auto mb-6 flex max-w-xs items-center justify-center gap-2 border-2 border-royal bg-navy px-3 py-1.5 text-[11px] font-black uppercase tracking-widest text-gold shadow-hard-sm sm:max-w-none">
              <span className="size-2 animate-pulse-block bg-gold" />
              Finance staff platform
              <span className="size-2 animate-pulse-block bg-gold" />
            </div>

            <h1 className="text-5xl font-black leading-[1.04] tracking-tight text-ink sm:text-7xl">
              KIRAT <span className="text-royal">MICRO CREDIT</span>
            </h1>

            <p className="mx-auto mt-5 max-w-xl text-2xl font-black uppercase tracking-tight text-muted-foreground sm:text-3xl sm:tracking-[0.04em]">
              Micro Finance · Micro Credit
            </p>

            <p className="mx-auto mt-4 max-w-lg text-sm font-bold leading-relaxed text-foreground/80">
              A mobile-first workspace for microfinance field staff, branch managers
              and accountants — loans, collections, cash, receipts and audit, all on
              the same money trail.
            </p>

            <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
              <Button
                size="lg"
                className="min-w-[200px] shadow-hard uppercase"
                onClick={() => navigate("/auth")}
              >
                Sign in
                <ArrowRight className="ml-2 size-4" />
              </Button>
              <p className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
                Email code or System ID sign-in · authorized by role on the server
              </p>
            </div>
          </div>
        </BannerWrapper>

        {/* Money stat tiles */}
        <div className="mt-12 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {MONEY_STATS.map((s) => (
            <div
              key={s.label}
              className="border-2 border-ink bg-card p-4 shadow-hard-sm text-left sm:p-4"
            >
              <div className="text-[11px] font-black uppercase tracking-widest text-muted-foreground">
                {s.label}
              </div>
              <div className="mt-1 text-2xl font-black leading-none tabular-nums sm:text-3xl">
                {s.value}
              </div>
              <div className="mt-1 text-[11px] font-bold text-muted-foreground">
                {s.sub}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Marquee */}
      <div aria-hidden className="overflow-hidden border-t-2 border-b-2 border-ink py-3 bg-navy text-paper">
        <div className="animate-marquee flex gap-16 whitespace-nowrap">
          {[...SCROLL_ITEMS, ...SCROLL_ITEMS].map((item, i) => (
            <div
              key={i}
              className="flex items-center gap-16 text-sm font-bold uppercase tracking-widest"
            >
              <span className="text-gold">{item.label}</span>
              <span className="text-paper/70">{item.value}</span>
              <span className="text-gold" aria-hidden>◆</span>
            </div>
          ))}
        </div>
      </div>

      {/* Features */}
      <section className="overflow-hidden px-4 py-16 sm:px-8 sm:py-24">
        <div className="mx-auto max-w-6xl">
          <div className="mb-10 text-center">
            <p className="text-[12px] font-black uppercase tracking-[0.2em] text-muted-foreground">
              The product, in six blocks
            </p>
            <h2 className="mt-2 text-2xl font-black uppercase tracking-tight sm:text-3xl">
              Built for the field, read from the ledger
            </h2>
            <p className="mx-auto mt-3 max-w-2xl text-sm font-bold text-foreground/80">
              Every screen — wallet, loan, collection, cash, audit — reads from the
              same derived balances. No one edits a number by hand.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f, i) => (
              <motion.div
                key={f.title}
                initial={{ opacity: 0, y: 10 }}
                animate={visible ? { opacity: 1, y: 0 } : {}}
                transition={{ duration: 0.4, delay: i * 0.06, ease: "easeOut" }}
              >
                <div
                  className={`border-2 border-ink bg-card p-4 shadow-hard-sm ${f.tone} text-left`}
                >
                  <div
                    className="mb-3 flex size-10 items-center justify-center border-2 border-ink bg-white shadow-hard-sm"
                  >
                    <f.icon className="size-4" />
                  </div>
                  <h3 className="mb-1.5 text-sm font-black uppercase tracking-tight">
                    {f.title}
                  </h3>
                  <p className="text-sm font-bold leading-relaxed text-foreground/80">
                    {f.body}
                  </p>
                </div>
              </motion.div>
              ))}
            </div>
          </div>
      </section>

      {/* Money trail strip */}
      <section className="border-t-2 border-ink bg-navy px-4 py-10 text-center sm:px-8 sm:py-14">
        <div className="mx-auto max-w-6xl">
          <p className="mb-6 text-[12px] font-black uppercase tracking-[0.2em] text-gold">
            Every rupee traces a path
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3 text-xs font-bold uppercase tracking-widest text-paper/80">
            <Step label="Treasury" />
            <Arrow />
            <Step label="Staff wallet" />
            <Arrow />
            <Step label="Loan disbursement" />
            <Arrow />
            <Step label="Client" />
            <Arrow />
            <Step label="Repayment" />
            <Arrow />
            <Step label="Collection + receipt" />
            <Arrow />
            <Step label="Cash handover" />
            <Arrow />
            <Step label="Branch / bank" />
          </div>
        </div>
      </section>

      {/* Info columns */}
      <section className="px-4 py-16 sm:px-8 sm:py-24">
        <div className="mx-auto max-w-6xl">
          <div className="mb-10 text-center">
            <p className="text-[12px] font-black uppercase tracking-[0.2em] text-muted-foreground">
              Designed for reality
            </p>
            <h2 className="mt-2 text-2xl font-black uppercase tracking-tight sm:text-3xl">
              Indian microfinance, as it runs
            </h2>
          </div>

          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            <InfoCard
              icon={Lock}
              title="Derived financial truth"
              body="Wallet balance, outstanding and closing difference are computed from transactions and journals. No editable balance field anywhere."
            />
            <InfoCard
              icon={History}
              title="Reversals, not deletes"
              body="Corrections are recorded as reversals with their own reference. The original entry stays intact, so the trail always explains itself."
            />
            <InfoCard
              icon={ClipboardList}
              title="Role-based shells"
              body="Field staff get a mobile-first shell with bottom nav and quick actions. Branch managers and accountants get the full admin UI."
            />
            <InfoCard
              icon={RefreshCw}
              title="Offline-first collections"
              body="Field mode queues collections locally and replays them with idempotency keys when the device is back online. Payments don't vanish."
            />
          </div>
        </div>
      </section>

      {/* Role-based access strip */}
      <section className="border-t-2 border-ink bg-gold/15 px-4 py-10 sm:px-8 sm:py-12">
        <div className="mx-auto max-w-4xl">
          <p className="mb-5 text-center text-[12px] font-black uppercase tracking-[0.2em] text-muted-foreground">
            Built for every role in the branch
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3 text-xs font-bold uppercase tracking-widest text-ink">
            <Badge label="Super Admin" hint="Full control" tone="bg-navy text-paper" />
            <Badge label="Branch Manager" hint="Branch workspace" tone="bg-royal text-white" />
            <Badge label="Accountant" hint="Ledger & approvals" tone="bg-mint" />
            <Badge label="Field staff" hint="Collections on the ground" tone="bg-gold text-ink" />
            <Badge label="Client" hint="Own account only" tone="bg-sky" />
          </div>
          <p className="mt-5 text-center text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
            Sign-in is email-verified, and every action is authorized server-side by role.
          </p>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t-2 border-ink bg-paper px-4 py-8 text-center sm:px-8">
        <div className="mx-auto flex max-w-6xl flex-col items-center gap-3">
          <Logo />
          <p className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
            KIRAT MICRO CREDIT — Micro Finance · Micro Credit
          </p>
          <p className="text-[11px] font-medium text-muted-foreground/70">
            Finance staff, wallet, loan and collection management — ledger-backed,
            audit-safe, field-ready.
          </p>
        </div>
      </footer>

      {/* Scroll shadow that follows the hero edge */}
      <MotionDiv top={scrollY} />
    </div>
  );
}

/* Small primitives */

function NavLink({ to, label }: { to: string; label: string }) {
  const navigate = useNavigate();
  return (
    <button
      onClick={() => navigate(to)}
      className="border-2 border-ink bg-card px-3 py-1.5 text-[11px] font-black uppercase tracking-widest shadow-hard-sm active:translate-x-[2px] active:translate-y-[2px] active:shadow-none hover:bg-royal hover:text-white"
    >
      {label}
    </button>
  );
}

function Step({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 border-2 border-ink bg-card px-3 py-1.5 text-ink shadow-hard-sm">
      <span className="size-2 border-2 border-ink bg-gold shadow-hard-sm" />
      {label}
    </div>
  );
}

function Arrow() {
  return (
    <div className="flex items-center border-2 border-ink bg-navy px-1.5 py-1 text-gold shadow-hard-sm">
      <ArrowRight className="size-3" />
    </div>
  );
}

function Badge({ label, hint, tone }: { label: string; hint: string; tone: string }) {
  return (
    <div
      className={`flex flex-col items-center border-2 border-ink px-3 py-2 text-center shadow-hard-sm ${tone}`}
    >
      <span className="text-[11px] font-black uppercase tracking-wider">{label}</span>
      <span className="text-[10px] font-mono font-bold opacity-80">{hint}</span>
    </div>
  );
}

function InfoCard({
  icon: Icon,
  title,
  body,
}: {
  icon: typeof Lock;
  title: string;
  body: string;
}) {
  return (
    <div className="border-2 border-ink bg-card p-4 shadow-hard-sm text-left">
      <div className="mb-3 flex items-center gap-3">
        <div className="grid size-8 place-items-center border-2 border-ink bg-royal shadow-hard-sm">
          <Icon className="size-4 text-white" />
        </div>
        <h3 className="text-sm font-black uppercase tracking-tight">{title}</h3>
      </div>
      <p className="text-sm font-bold leading-relaxed text-foreground/80">{body}</p>
    </div>
  );
}

/** Thin shadow band pinned to the top of the hero, scaled by scroll. */
function MotionDiv({ top }: { top: number }) {
  return (
    <motion.div
      initial={{ y: 0, height: 0 }}
      animate={{ y: top > 200 ? 0 : -120, height: top > 200 ? 4 : 0 }}
      transition={{ duration: 0.15 }}
      className="pointer-events-none fixed left-0 right-0 z-40 h-3 bg-gradient-to-b from-paper/0 via-paper/60 to-paper/0"
      aria-hidden
    />
  );
}

/** Keeps the animated hero block mounted even if framer motion is missing. */
function BannerWrapper({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
