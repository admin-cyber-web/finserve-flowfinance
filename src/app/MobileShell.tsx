import { api } from "@/convex/_generated/api";
import { StatusChip, timeAgo } from "@/components/fs/primitives";
import { useOnline, useProfile } from "@/hooks/use-profile";
import { cn } from "@/lib/utils";
import {
  clearSynced,
  patchQueueItem,
  readQueue,
  type QueuedCollection,
} from "@/lib/offline";
import { useConvex, useMutation, useQuery } from "convex/react";
import {
  Bell,
  Building2,
  ChevronDown,
  Home,
  IndianRupee,
  LayoutList,
  Loader2,
  LogOut,
  Plus,
  Search,
  RefreshCw,
  User,
  Wallet,
  X,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { BottomSheet } from "@/components/fs/primitives";

const NAV = [
  { to: "/dashboard", label: "Home", icon: Home, end: true },
  { to: "/dashboard/clients", label: "Clients", icon: LayoutList },
  { to: "/dashboard/transactions", label: "Activity", icon: IndianRupee },
  { to: "/dashboard/reports", label: "Reports", icon: Building2 },
  { to: "/dashboard/profile", label: "Profile", icon: User },
];

/** Replays queued offline collections once connectivity returns. */
export function useOfflineQueue() {
  const convex = useConvex();
  const [items, setItems] = useState<QueuedCollection[]>([]);
  const [syncing, setSyncing] = useState(false);
  const online = useOnline();

  const refresh = () => setItems(readQueue());
  useEffect(() => {
    refresh();
  }, []);

  const pending = items.filter(
    (i) => i.status === "PENDING" || i.status === "FAILED",
  );

  const sync = async (): Promise<number> => {
    const queue = readQueue().filter(
      (i) => i.status === "PENDING" || i.status === "FAILED",
    );
    if (!queue.length) return 0;
    setSyncing(true);
    let done = 0;
    for (const item of queue) {
      patchQueueItem(item.id, { status: "SYNCING", error: undefined });
      refresh();
      try {
        await convex.mutation(api.collections.collect, {
          loanId: item.loanId as never,
          amount: item.amount,
          mode: item.mode,
          remarks: item.remarks,
          idempotencyKey: item.idempotencyKey,
          device: "offline-queue",
        });
        patchQueueItem(item.id, { status: "SYNCED" });
        done += 1;
      } catch (err) {
        patchQueueItem(item.id, {
          status: "FAILED",
          error: err instanceof Error ? err.message : "Sync failed",
        });
      }
      refresh();
    }
    setSyncing(false);
    if (done) toast.success(`${done} offline payment${done > 1 ? "s" : ""} synced`);
    setTimeout(() => {
      clearSynced();
      refresh();
    }, 2500);
    return done;
  };

  useEffect(() => {
    if (online && pending.length) {
      void sync();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online]);

  return { items, pending: pending.length, syncing, sync, refresh };
}

function initials(name?: string | null): string {
  if (!name) return "?";
  return name
    .split(" ")
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

export function MobileShell({ children }: { children: ReactNode }) {
  const { profile, signOut } = useProfile();
  const navigate = useNavigate();
  const location = useLocation();
  const online = useOnline();
  const { pending, syncing, sync } = useOfflineQueue();

  const [notifOpen, setNotifOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");

  const notifications = useQuery(api.admin.notifications, { limit: 20 });
  const markRead = useMutation(api.admin.markRead);
  const markAllRead = useMutation(api.admin.markAllRead);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 250);
    return () => clearTimeout(t);
  }, [q]);

  const results = useQuery(
    api.admin.search,
    debounced.trim().length >= 2 ? { q: debounced.trim() } : "skip",
  );

  useEffect(() => {
    setNotifOpen(false);
    setSearchOpen(false);
    setQuickOpen(false);
    setMenuOpen(false);
  }, [location.pathname]);

  const unread = notifications?.unread ?? 0;

  const quickActions = [
    {
      label: "Collect payment",
      icon: IndianRupee,
      to: "/dashboard/collect",
      tone: "bg-mint",
    },
    {
      label: "Give loan",
      icon: Wallet,
      to: "/dashboard/loans/new",
      tone: "bg-gold",
    },
    {
      label: "Add client",
      icon: Plus,
      to: "/dashboard/clients/new",
      tone: "bg-sky",
    },
    {
      label: "Cash handover",
      icon: Building2,
      to: "/dashboard/cash",
      tone: "bg-clay",
    },
  ];

  return (
    <div className="relative mx-auto min-h-screen w-full max-w-[520px] border-x-2 border-ink bg-paper">
      {/* Offline / sync banner */}
      {(!online || pending > 0) && (
        <div
          className={cn(
            "sticky top-0 z-40 flex items-center justify-between gap-2 border-b-2 border-ink px-3 py-1.5 text-xs font-black uppercase",
            online ? "bg-gold" : "bg-navy text-paper",
          )}
        >
          <span className="flex items-center gap-1.5">
            {!online && <span className="size-2 animate-pulse-block bg-gold" />}
            {!online
              ? pending
                ? `Offline · ${pending} queued`
                : "Offline — viewing cached data"
              : `Pending sync: ${pending}`}
          </span>
          {online && pending > 0 && (
            <button
              onClick={() => void sync()}
              className="flex items-center gap-1 border-2 border-ink bg-white px-2 py-0.5 text-ink"
            >
              {syncing ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
              {syncing ? "Syncing" : "Sync now"}
            </button>
          )}
        </div>
      )}

      {/* Header */}
      <header className="sticky top-0 z-30 flex items-center gap-3 border-b-2 border-ink bg-card px-3 py-2.5">
        <button
          onClick={() => setMenuOpen(true)}
          className="grid size-10 shrink-0 place-items-center border-2 border-ink bg-navy font-black text-gold shadow-hard-sm"
          aria-label="Menu"
        >
          {initials(profile?.name)}
        </button>
        <button
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          onClick={() => setMenuOpen(true)}
          aria-label="Account menu"
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-black leading-tight">
              {profile?.name ?? "—"}
            </span>
            <span className="block truncate font-mono text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
              {profile?.staffId} · {profile?.branch?.name ?? "No branch"}
            </span>
          </span>
          <ChevronDown className="size-4 shrink-0" />
        </button>
        <button
          onClick={() => setSearchOpen(true)}
          className="grid size-10 place-items-center border-2 border-ink bg-white shadow-hard-sm active:translate-x-[2px] active:translate-y-[2px] active:shadow-none"
          aria-label="Search"
        >
          <Search className="size-4" />
        </button>
        <button
          onClick={() => setNotifOpen(true)}
          className="relative grid size-10 place-items-center border-2 border-ink bg-white shadow-hard-sm active:translate-x-[2px] active:translate-y-[2px] active:shadow-none"
          aria-label="Notifications"
        >
          <Bell className="size-4" />
          {unread > 0 && (
            <span className="absolute -right-2 -top-2 grid min-w-5 place-items-center border-2 border-ink bg-destructive px-1 text-[10px] font-black text-white">
              {unread > 9 ? "9+" : unread}
            </span>
          )}
        </button>
      </header>

      {/* Content */}
      <main className="px-3 pb-28 pt-4">{children}</main>

      {/* Bottom nav */}
      <nav className="fixed inset-x-0 bottom-0 z-30 mx-auto w-full max-w-[520px] border-t-2 border-ink bg-card">
        <div className="grid grid-cols-6 items-end pb-[env(safe-area-inset-bottom)]">
          {NAV.slice(0, 2).map((item) => (
            <NavButton key={item.to} {...item} pathname={location.pathname} />
          ))}
          <div className="flex justify-center pb-2">
            <button
              onClick={() => setQuickOpen(true)}
              aria-label="Quick actions"
              className="-mt-7 grid size-16 place-items-center border-2 border-ink bg-royal text-white shadow-hard active:translate-x-[2px] active:translate-y-[2px] active:shadow-none"
            >
              <Plus className="size-8" strokeWidth={3} />
            </button>
          </div>
          {NAV.slice(2).map((item) => (
            <NavButton key={item.to} {...item} pathname={location.pathname} />
          ))}
        </div>
      </nav>

      {/* Quick actions */}
      <BottomSheet
        open={quickOpen}
        onOpenChange={setQuickOpen}
        title="Quick actions"
        subtitle="Field operations — three taps or fewer"
      >
        <div className="grid grid-cols-2 gap-3">
          {quickActions.map((a) => (
            <button
              key={a.to}
              onClick={() => navigate(a.to)}
              className={cn(
                "flex flex-col items-start gap-3 border-2 border-ink p-4 text-left shadow-hard-sm active:translate-x-[2px] active:translate-y-[2px] active:shadow-none",
                a.tone,
              )}
            >
              <span className="grid size-9 place-items-center border-2 border-ink bg-white">
                <a.icon className="size-4" />
              </span>
              <span className="text-sm font-black uppercase leading-tight">
                {a.label}
              </span>
            </button>
          ))}
        </div>
      </BottomSheet>

      {/* Notifications */}
      <BottomSheet
        open={notifOpen}
        onOpenChange={setNotifOpen}
        title="Notifications"
        subtitle={unread ? `${unread} unread` : "You're all caught up"}
      >
        <div className="mb-3 flex justify-end">
          <Button size="sm" variant="outline" onClick={() => void markAllRead({})}>
            Mark all read
          </Button>
        </div>
        <div className="flex flex-col gap-2">
          {(notifications?.rows ?? []).length === 0 && (
            <p className="py-6 text-center text-sm font-bold text-muted-foreground">
              No notifications yet.
            </p>
          )}
          {(notifications?.rows ?? []).map((n) => (
            <button
              key={n._id}
              onClick={async () => {
                await markRead({ notificationId: n._id });
                if (n.link) navigate(n.link);
              }}
              className={cn(
                "border-2 border-ink p-3 text-left",
                n.read ? "bg-white" : "bg-sky shadow-hard-sm",
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-black uppercase tracking-wide">
                  {n.title}
                </span>
                <span className="text-[10px] font-bold text-muted-foreground">
                  {timeAgo(n.createdAt)}
                </span>
              </div>
              <p className="mt-1 text-xs font-semibold leading-snug">{n.body}</p>
            </button>
          ))}
        </div>
      </BottomSheet>

      {/* Global search */}
      <BottomSheet
        open={searchOpen}
        onOpenChange={setSearchOpen}
        title="Search"
        subtitle="Clients, loans, receipts, staff, transactions"
      >
        <div className="flex items-center border-2 border-ink bg-white">
          <Search className="ml-3 size-4 shrink-0" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Name, mobile, C-000128, LN-…, RCPT-…"
            className="h-11 w-full bg-transparent px-3 text-sm font-bold outline-none"
          />
          {q && (
            <button onClick={() => setQ("")} className="mr-2 p-1">
              <X className="size-4" />
            </button>
          )}
        </div>
        <div className="mt-3 flex flex-col gap-2">
          {(results ?? []).length === 0 && debounced.trim().length >= 2 && (
            <p className="py-4 text-center text-sm font-bold text-muted-foreground">
              No matches for “{debounced}”.
            </p>
          )}
          {(results ?? []).map((r) => (
            <button
              key={`${r.kind}:${r.id}`}
              onClick={() => navigate(r.href)}
              className="flex items-center justify-between gap-3 border-2 border-ink bg-white p-3 text-left shadow-hard-sm active:translate-x-[2px] active:translate-y-[2px] active:shadow-none"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-black">{r.title}</span>
                <span className="block truncate text-xs font-semibold text-muted-foreground">
                  {r.subtitle}
                </span>
              </span>
              <StatusChip label={r.kind} tone="info" />
            </button>
          ))}
          {(results ?? []).length === 0 && debounced.trim().length < 2 && (
            <p className="py-4 text-center text-xs font-semibold text-muted-foreground">
              Try “Ramesh”, “C-000128”, “LN-000001” or a receipt number.
            </p>
          )}
        </div>
      </BottomSheet>

      {/* Profile menu */}
      <BottomSheet
        open={menuOpen}
        onOpenChange={setMenuOpen}
        title={profile?.name ?? "Account"}
        subtitle={`${profile?.staffId ?? ""} · ${profile?.branch?.name ?? ""}`}
      >
        <div className="flex flex-col gap-2">
          <MenuLink to="/dashboard/profile" label="Profile & wallet" icon={Wallet} />
          <MenuLink to="/dashboard/cash" label="Cash management" icon={Building2} />
          <MenuLink to="/dashboard/loans" label="My loans" icon={IndianRupee} />
          <MenuLink to="/dashboard/reports" label="Reports" icon={LayoutList} />
          <Button
            variant="destructive"
            className="mt-2 w-full"
            onClick={() => void signOut().then(() => navigate("/auth"))}
          >
            <LogOut className="size-4" /> Logout
          </Button>
        </div>
      </BottomSheet>

    </div>
  );
}

function NavButton({
  to,
  label,
  icon: Icon,
  end,
  pathname,
}: {
  to: string;
  label: string;
  icon: typeof Home;
  end?: boolean;
  pathname: string;
}) {
  const navigate = useNavigate();
  const active = end ? pathname === to : pathname.startsWith(to);
  return (
    <button
      onClick={() => navigate(to)}
      className={cn(
        "flex flex-col items-center gap-0.5 py-2.5 text-[10px] font-black uppercase tracking-wide",
        active ? "text-royal" : "text-muted-foreground",
      )}
    >
      <span
        className={cn(
          "grid size-7 place-items-center border-2",
          active ? "border-ink bg-gold text-ink" : "border-transparent",
        )}
      >
        <Icon className="size-4" />
      </span>
      {label}
    </button>
  );
}

function MenuLink({
  to,
  label,
  icon: Icon,
}: {
  to: string;
  label: string;
  icon: typeof Home;
}) {
  const navigate = useNavigate();
  return (
    <button
      onClick={() => navigate(to)}
      className="flex items-center gap-3 border-2 border-ink bg-white p-3 text-left text-sm font-black uppercase shadow-hard-sm active:translate-x-[2px] active:translate-y-[2px] active:shadow-none"
    >
      <Icon className="size-4" />
      {label}
    </button>
  );
}
