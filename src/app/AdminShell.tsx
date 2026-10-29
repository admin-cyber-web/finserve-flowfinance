import { api } from "@/convex/_generated/api";
import {
  Logo,
  StatusChip,
  timeAgo,
} from "@/components/fs/primitives";
import { BottomSheet } from "@/components/fs/primitives";
import { useProfile } from "@/hooks/use-profile";
import { cn } from "@/lib/utils";
import { useMutation, useQuery } from "convex/react";
import {
  AlertTriangle,
  Bell,
  BookOpen,
  Banknote,
  Coins,
  FileBarChart,
  LayoutDashboard,
  Loader2,
  LogOut,
  HandCoins,
  Search,
  ShieldCheck,
  Stamp,
  UserCog,
  Users,
  UsersRound,
  X,
  ChevronDown,
  User,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Permission } from "@/lib/finance/permissions";

/** Wordmark for the deep-saffron navigation surfaces. */
function BrandWordmark({ className }: { className?: string }) {
  return (
    <span className={className}>
      <span className="block text-base font-black leading-none tracking-tight text-paper">
        KIRAT
      </span>
      <span className="block text-[10px] font-black uppercase tracking-[0.22em] text-paper/70">
        Micro Credit
      </span>
    </span>
  );
}

/** Fixed bottom-left START toggle — the only menu control visible at rest.
 *  Pressing it slides the menu up from the bottom; pressing it again slides
 *  the menu back down. */
function StartButton({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={open ? "Close menu" : "Open menu"}
      aria-expanded={open}
      aria-controls="start-menu"
      className="flex h-10 min-w-[7.5rem] items-center justify-center rounded-[0.375rem] px-5 text-sm font-black uppercase tracking-[0.18em] text-white transition-shadow duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-2 focus-visible:ring-offset-navy"
      style={{
        background: "#F07800",
        boxShadow: open
          ? "0 0 16px 2px rgba(240,120,0,0.55), 0 2px 8px rgba(240,120,0,0.45)"
          : "0 2px 8px rgba(240,120,0,0.45)",
        cursor: "pointer",
      }}
    >
      START
    </button>
  );
}

interface NavItem {
  to: string;
  label: string;
  icon: typeof Users;
  permission?: Permission;
  /** When set, the item only renders for this exact profile role. */
  role?: string;
  /** When set, the item only renders for one of these exact roles. */
  roles?: string[];
  end?: boolean;
}

const NAV: NavItem[] = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/dashboard/clients", label: "Clients", icon: Users, permission: "view_clients" },
  { to: "/dashboard/loans", label: "Loans", icon: Banknote, permission: "view_loans" },
  { to: "/dashboard/approvals", label: "Approvals", icon: Stamp },
  { to: "/dashboard/collection", label: "Collection", icon: Coins, permission: "collect_payment" },
  { to: "/dashboard/staff", label: "Staff & Wallets", icon: UserCog, permission: "staff_management" },
  {
    to: "/dashboard/users",
    label: "User Management",
    icon: UsersRound,
    permission: "block_staff",
    role: "SUPER_ADMIN",
  },
  { to: "/dashboard/cash", label: "Cash & Handovers", icon: HandCoins, permission: "cash_handover" },
  { to: "/dashboard/overdue", label: "Overdue & Recovery", icon: AlertTriangle, permission: "reports" },
  { to: "/dashboard/reports", label: "Reports", icon: FileBarChart, permission: "reports" },
  { to: "/dashboard/accounting", label: "Accounting", icon: BookOpen, permission: "accounting" },
  { to: "/dashboard/audit", label: "Audit & Money Trail", icon: ShieldCheck, permission: "audit_logs" },
];

const TITLES: Record<string, string> = {
  "/dashboard": "Dashboard",
  "/dashboard/clients": "Clients",
  "/dashboard/loans": "Loans",
  "/dashboard/approvals": "Approvals",
  "/dashboard/collection": "Collection",
  "/dashboard/staff": "Staff & Wallets",
  "/dashboard/users": "User Management",
  "/dashboard/cash": "Cash & Handovers",
  "/dashboard/overdue": "Overdue & Recovery",
  "/dashboard/reports": "Reports",
  "/dashboard/accounting": "Accounting",
  "/dashboard/audit": "Audit & Money Trail",
};

function initials(name?: string | null): string {
  if (!name) return "?";
  return name
    .split(" ")
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

function NavList({
  pathname,
  onNavigate,
  allowed,
  role,
  approvalsBadge,
  saffronHover = false,
}: {
  pathname: string;
  onNavigate?: () => void;
  allowed: (p?: Permission) => boolean;
  role?: string | null;
  approvalsBadge: number;
  saffronHover?: boolean;
}) {
  const navigate = useNavigate();
  return (
    <nav className="flex flex-col gap-1">
      {NAV.filter(
        (item) =>
          allowed(item.permission) &&
          (!item.role || item.role === role) &&
          (!item.roles || item.roles.includes(role ?? "")),
      ).map((item) => {
        const active = item.end
          ? pathname === item.to
          : pathname.startsWith(item.to);
        return (
          <button
            key={item.to}
            onClick={() => {
              navigate(item.to);
              onNavigate?.();
            }}
            className={cn(
              "flex items-center gap-3 border-2 px-3 py-2.5 text-left text-sm font-black uppercase tracking-wide transition-colors duration-200",
              active
                ? "border-ink bg-gold text-ink shadow-hard-sm"
                : cn(
                    "border-transparent text-paper/80",
                    saffronHover &&
                      "lg:hover:border-[#F07800] lg:hover:bg-[#F07800]/20 lg:hover:text-paper",
                  ),
            )}
          >
            <item.icon className="size-4 shrink-0" />
            <span className="flex-1">{item.label}</span>
            {item.to === "/dashboard/approvals" && approvalsBadge > 0 && (
              <span className="grid min-w-5 place-items-center border-2 border-ink bg-destructive px-1 text-[10px] font-black text-white">
                {approvalsBadge}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}

export function AdminShell({ children }: { children: ReactNode }) {
  const { profile, can, role: profileRole, signOut } = useProfile();
  const location = useLocation();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const accountBlocked = Boolean(profile?.status && profile.status !== "ACTIVE");
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
    setMenuOpen(false);
    setNotifOpen(false);
    setSearchOpen(false);
  }, [location.pathname]);

  const allowed = (p?: Permission) => (p ? can(p) : true);
  const unread = notifications?.unread ?? 0;
  const title =
    TITLES[location.pathname] ??
    (location.pathname.startsWith("/dashboard/clients/")
      ? "Client 360°"
      : location.pathname.startsWith("/dashboard/loans/")
        ? "Loan file"
        : location.pathname.startsWith("/dashboard/staff/")
          ? "Staff 360°"
          : location.pathname.startsWith("/dashboard/receipts/")
            ? "Receipt"
            : "KIRAT MICRO CREDIT");

  return (
    <div className="min-h-screen bg-paper">
      {/* Content — full screen; shifts right when the START sidebar is open */}
      <div
        className={cn(
          "transition-[padding] duration-300 ease-out",
          menuOpen && "lg:pl-64",
        )}
      >
        <header className="sticky top-0 z-30 flex items-center gap-3 border-b-2 border-ink bg-card px-3 py-3 lg:px-6">
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-black uppercase tracking-tight lg:text-lg">
              {title}
            </h1>
          </div>
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
          {/* Account dropdown — profile info, account links and the Sign Out
              option live here; unchanged. */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="flex items-center gap-2 border-2 border-ink bg-white px-2 py-1.5 shadow-hard-sm active:translate-x-[2px] active:translate-y-[2px] active:shadow-none"
                aria-label="Account menu"
              >
                <span className="grid size-8 shrink-0 place-items-center border-2 border-ink bg-gold text-xs font-black text-ink">
                  {initials(profile?.name)}
                </span>
                <ChevronDown className="size-4 shrink-0" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="w-64 border-2 border-ink bg-card shadow-hard"
            >
              <DropdownMenuLabel className="px-3 py-2.5">
                <p className="truncate text-sm font-black">{profile?.name}</p>
                <p className="truncate font-mono text-[10px] font-bold uppercase text-muted-foreground">
                  {profile?.staffId}
                </p>
                <p className="truncate text-[11px] font-semibold text-muted-foreground">
                  {profile?.branch?.name ?? "Organization-wide"} ·{" "}
                  {profile?.role?.replace("_", " ").toLowerCase()}
                </p>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="cursor-pointer text-xs font-black uppercase"
                onSelect={() => navigate("/dashboard/profile")}
              >
                <User className="size-4" /> My profile
              </DropdownMenuItem>
              <DropdownMenuItem
                className="cursor-pointer text-xs font-black uppercase"
                onSelect={() => navigate("/dashboard/transactions")}
              >
                <Banknote className="size-4" /> Transactions
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                className="cursor-pointer text-xs font-black uppercase"
                onSelect={() => void signOut().then(() => navigate("/auth"))}
              >
                <LogOut className="size-4" /> Logout
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </header>

        <main className="mx-auto max-w-[1360px] px-3 py-4 lg:px-6 lg:py-6">
          {children}
        </main>
      </div>

      {/* Notifications */}
      <BottomSheet
        open={notifOpen}
        onOpenChange={setNotifOpen}
        title="Notifications"
        subtitle={unread ? `${unread} unread` : "All caught up"}
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
                <span className="text-xs font-black uppercase">{n.title}</span>
                <span className="text-[10px] font-bold text-muted-foreground">
                  {timeAgo(n.createdAt)}
                </span>
              </div>
              <p className="mt-1 text-xs font-semibold">{n.body}</p>
            </button>
          ))}
        </div>
      </BottomSheet>

      {/* Search */}
      <BottomSheet
        open={searchOpen}
        onOpenChange={setSearchOpen}
        title="Global search"
        subtitle="Clients · loans · receipts · staff · transactions"
      >
        <div className="flex items-center border-2 border-ink bg-white">
          <Search className="ml-3 size-4 shrink-0" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}             placeholder="000128, LN-000001, Rahul…"
            className="h-11 w-full bg-transparent px-3 text-sm font-bold outline-none"
          />
        </div>
        <div className="mt-3 flex flex-col gap-2">
          {(results ?? []).map((r) => (
            <button
              key={`${r.kind}:${r.id}`}
              onClick={() => navigate(r.href)}
              className="flex items-center justify-between gap-3 border-2 border-ink bg-white p-3 text-left shadow-hard-sm"
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
          {(results ?? []).length === 0 && debounced.trim().length >= 2 && (
            <p className="py-4 text-center text-sm font-bold text-muted-foreground">
              No matches.
            </p>
          )}
          {debounced.trim().length < 2 && (
            <p className="py-4 text-center text-xs font-semibold text-muted-foreground">
              Search across the whole organization.
            </p>
          )}
        </div>
      </BottomSheet>

      {/* Fixed bottom-left START toggle — the only menu control at rest */}
      <div
        className={cn(
          "fixed left-4 z-[60]",
          accountBlocked ? "bottom-14" : "bottom-4",
        )}
      >
        <StartButton open={menuOpen} onClick={() => setMenuOpen((v) => !v)} />
      </div>

      {/* Dim-behind scrim for small screens (desktop shifts content instead) */}
      <div
        onClick={() => setMenuOpen(false)}
        aria-hidden="true"
        className={cn(
          "fixed inset-0 z-40 bg-ink transition-opacity duration-300 lg:hidden",
          menuOpen ? "opacity-50" : "pointer-events-none opacity-0",
        )}
      />

      {/* START menu — a compact left sidebar that slides up from the bottom.
          It stays within a fixed-width strip on the left; on desktop the
          dashboard shifts right (lg:pl-64) so it remains fully visible. */}
      <aside
        id="start-menu"
        aria-hidden={!menuOpen}
        className={cn(
          "fixed bottom-0 left-0 top-0 z-50 flex w-64 max-w-[80vw] flex-col overflow-hidden border-r-2 border-ink bg-navy transition-transform duration-300 ease-out",
          menuOpen ? "translate-y-0" : "translate-y-full",
        )}
      >
        <div className="flex items-center justify-between border-b-2 border-paper/20 px-3 py-2.5">
          <BrandWordmark className="block" />
          <button
            onClick={() => setMenuOpen(false)}
            aria-label="Close menu"
            className="grid size-8 place-items-center border-2 border-paper/40 text-paper active:translate-y-[1px]"
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          <NavList
            pathname={location.pathname}
            onNavigate={() => setMenuOpen(false)}
            allowed={allowed}
            role={profileRole}
            approvalsBadge={unread}
            saffronHover
          />
        </div>
      </aside>

      {profile?.status && profile.status !== "ACTIVE" && (
        <div className="fixed inset-x-0 bottom-0 z-50 flex items-center justify-between gap-3 border-t-2 border-ink bg-destructive px-4 py-2 text-xs font-black uppercase text-white">
          <span>Account {profile.status} — actions are blocked</span>
          <Loader2 className="size-4 animate-spin" />
        </div>
      )}
    </div>
  );
}

export { Logo };
