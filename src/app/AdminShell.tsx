import { api } from "@/convex/_generated/api";import { Logo,
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
  FileBarChart,
  LayoutDashboard,
  Loader2,
  LogOut,
  HandCoins,
  Menu,
  Package,
  Search,
  ShieldCheck,
  Stamp,
  UserCog,
  Users,
  X,
} from "lucide-react";
import React from "react";
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
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { ChevronDown, PanelLeftClose, PanelLeftOpen, User } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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
import { useEffect, useState, type ReactNode, useRef } from "react";

/** Custom keyboard-accessible animated START/KMC button for the desktop
 *  sidebar. Uses two stacked spans so the label cross-fade is smooth and
 *  the background glow can pulse independently of the text. */
function StartButton({
  kmc,
  onClick,
  onMouseEnter,
  onMouseLeave,
}: {
  kmc: boolean;
  onClick: () => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className="w-full"
      aria-label="Show tagline"
      aria-expanded={false}
      style={{ fontFamily: "inherit", borderRadius: 0, cursor: "pointer" }}
    >
      <span
        className="relative inline-flex items-center justify-center"
        style={{
          background: "#F07800",
          boxShadow: "0 2px 8px rgba(240,120,0,0.45)",
          borderRadius: "0.375rem",
        }}
      >
        {/* Ink-coloured backup layer, fades in on hover */}
        <span
          className="absolute inset-0 flex items-center justify-center transition-all duration-300 ease-out"
          style={{
            background: "#F07800",
            boxShadow: "0 2px 8px rgba(240,120,0,0.5)",
            borderRadius: "0.375rem",
            opacity: kmc ? 1 : 0,
          }}
        >
          <span
            className="relative inline-flex items-center justify-center h-9 w-[9.5rem] text-ink font-black uppercase tracking-[0.08em]"
            style={{ transition: "all 300ms ease" }}
          >
            KMC
          </span>
        </span>

        {/* Saffron START layer, fades out on hover */}
        <span
          className="absolute inset-0 flex items-center justify-center transition-all duration-300 ease-out"
          style={{
            background: "#E88900",
            boxShadow: "0 2px 8px rgba(240,120,0,0.45)",
            borderRadius: "0.375rem",
            opacity: kmc ? 0 : 1,
          }}
        >
          <span
            className="relative inline-flex items-center justify-center h-5 w-12 text-white font-black uppercase tracking-[0.06em]"
            style={{ transition: "all 300ms ease" }}
          >
            START
          </span>
        </span>
      </span>
    </button>
  );
}
import React from "react";
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
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { ChevronDown, PanelLeftClose, PanelLeftOpen, User } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { Permission } from "@/lib/finance/permissions";

interface NavItem {
  to: string;
  label: string;
  icon: typeof Users;
  permission?: Permission;
  end?: boolean;
}

const NAV: NavItem[] = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/dashboard/clients", label: "Clients", icon: Users, permission: "view_clients" },
  { to: "/dashboard/loans", label: "Loans", icon: Banknote, permission: "view_loans" },
  { to: "/dashboard/approvals", label: "Approvals", icon: Stamp },
  { to: "/dashboard/staff", label: "Staff & Wallets", icon: UserCog, permission: "staff_management" },
  { to: "/dashboard/cash", label: "Cash & Handovers", icon: HandCoins, permission: "cash_handover" },
  { to: "/dashboard/overdue", label: "Overdue & Recovery", icon: AlertTriangle, permission: "reports" },
  { to: "/dashboard/reports", label: "Reports", icon: FileBarChart, permission: "reports" },
  { to: "/dashboard/accounting", label: "Accounting", icon: BookOpen, permission: "accounting" },
  { to: "/dashboard/audit", label: "Audit & Money Trail", icon: ShieldCheck, permission: "audit_logs" },
  { to: "/dashboard/products", label: "Loan Products", icon: Package, permission: "view_loans" },
];

const TITLES: Record<string, string> = {
  "/dashboard": "Dashboard",
  "/dashboard/clients": "Clients",
  "/dashboard/loans": "Loans",
  "/dashboard/approvals": "Approvals",
  "/dashboard/staff": "Staff & Wallets",
  "/dashboard/cash": "Cash & Handovers",
  "/dashboard/overdue": "Overdue & Recovery",
  "/dashboard/reports": "Reports",
  "/dashboard/accounting": "Accounting",
  "/dashboard/audit": "Audit & Money Trail",
  "/dashboard/products": "Loan Products",
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
  approvalsBadge,
  collapsed = false,
}: {
  pathname: string;
  onNavigate?: () => void;
  allowed: (p?: Permission) => boolean;
  approvalsBadge: number;
  collapsed?: boolean;
}) {
  const navigate = useNavigate();
  return (
    <nav className="flex flex-col gap-1">
      {NAV.filter((item) => allowed(item.permission)).map((item) => {
        const active = item.end
          ? pathname === item.to
          : pathname.startsWith(item.to);
        const button = (
          <button
            key={item.to}
            onClick={() => {
              navigate(item.to);
              onNavigate?.();
            }}
            className={cn(
              "flex items-center gap-3 border-2 px-3 py-2.5 text-left text-sm font-black uppercase tracking-wide transition-colors",
              collapsed && "relative justify-center px-0",
              active
                ? "border-ink bg-gold text-ink shadow-hard-sm"
                : "border-transparent text-paper/80 hover:border-paper/30 hover:bg-white/10",
            )}
          >
            <item.icon className="size-4 shrink-0" />
            <span className={cn("flex-1", collapsed && "sr-only")}>
              {item.label}
            </span>
            {item.to === "/dashboard/approvals" && approvalsBadge > 0 && (
              <span
                className={cn(
                  "grid min-w-5 place-items-center border-2 border-ink bg-destructive px-1 text-[10px] font-black text-white",
                  collapsed && "absolute right-1 top-1 min-w-4 px-0.5 text-[9px]",
                )}
              >
                {approvalsBadge}
              </span>
            )}
          </button>
        );
        return collapsed ? (
          <Tooltip key={item.to}>
            <TooltipTrigger asChild>{button}</TooltipTrigger>
            <TooltipContent side="right">{item.label}</TooltipContent>
          </Tooltip>
        ) : (
          button
        );
      })}
    </nav>
  );
}

export function AdminShell({ children }: { children: ReactNode }) {
  const { profile, can, role: profileRole, signOut } = useProfile();
  const location = useLocation();
  const navigate = useNavigate();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  // Desktop-only 2-state sidebar (mobile Sheet navigation is separate
  // and unaffected by this state). Cycle: expanded / tagline / expanded ...
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [kmc, setKmc] = useState(false);
  const roleLabel = profileRole?.replace("_", " ").toLowerCase() ?? "user";
  const taglineRef = useRef<HTMLSpanElement>(null);
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
    setDrawerOpen(false);
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

  /** Exact tagline displayed in the sidebar's State B (menu hidden). */
  const EXACT_TAGLINE = "सपने आपके, भरोसा हमारा — KIRAT MICRO CREDIT";
  const taglineLines = EXACT_TAGLINE.split(/\n/);

  return (
    <div className="min-h-screen bg-paper">
      {/* Desktop sidebar */}
      <aside
        id="desktop-sidebar"
        className={cn(
          "fixed inset-y-0 left-0 z-40 hidden w-64 flex-col overflow-hidden border-r-2 border-ink bg-navy transition-[width] duration-300 ease-in-out lg:flex",
          sidebarOpen && "lg:pointer-events-none lg:opacity-0 lg:relative lg:translate-x-[-2px]",
        )}
      >
        <div
          className={cn(
            "border-b-2 border-paper/20 px-4 py-4",
            sidebarOpen && "flex justify-center px-2",
          )}
        >
          {sidebarOpen ? (
            <BrandWordmark className="block" />
          ) : (
            <Logo withWordmark={false} />
          )}
        </div>
        <div className="flex-1 overflow-y-auto p-3">
          {/* State A: expanded menu. State B (tagline) is rendered at the
              very bottom of the sidebar when sidebarOpen is false; the NavList
              itself is never rendered in State B. */}
          {sidebarOpen && (
            <NavList
              pathname={location.pathname}
              allowed={allowed}
              approvalsBadge={notifications?.unread ?? 0}
              collapsed={false}
            />
          )}
        </div>
        <div className="border-t-2 border-paper/20 p-3">
          <div
            className={cn(
              "mb-2 flex items-center gap-2",
              sidebarOpen && "justify-center",
            )}
          >
            <span className="grid size-9 shrink-0 place-items-center border-2 border-paper bg-gold text-xs font-black text-ink">
              {initials(profile?.name)}
            </span>
            <div className={cn("min-w-0", sidebarOpen && "hidden")}>
              <div className="truncate text-xs font-black text-paper">
                {profile?.name}
              </div>
              <div className="truncate font-mono text-[10px] font-bold uppercase text-paper/60">
                {profile?.staffId}
              </div>
            </div>
          </div>
          {sidebarOpen ? (
            <div
              className="flex items-center justify-center gap-2 border-2 border-ink bg-white px-3 py-2 shadow-hard-sm"
              onMouseEnter={() => setMouseEntered(true)}
              onMouseLeave={() => setMouseLeft(false)}
            >
              <span className="grid size-9 shrink-0 place-items-center border-2 border-ink bg-royal text-xs font-black text-white shadow-hard-sm">
                <IndianRupee className="size-4" />
              </span>
              <span
                className="relative text-base font-black leading-[1.4] tracking-wide text-ink"
                ref={(el) => {
                  const el0 = el;
                  if (!el0) return;
                  const h = el0.offsetWidth;
                  (el0.firstChild as HTMLElement).textContent = roleLabel;
                  el0.style.textIndent = `${Math.min(0, h - el0.offsetWidth)}px`;
                }}
                style={{ textIndent: "0px" }}
              >                {""}
              </span>
              <span className="text-[10px] font-black uppercase tracking-[0.18em] text-muted-foreground">
                {roleLabel}
              </span>
            </div>
          ) : (
            <div className="relative">              <StartButton
                kmc={kmc}
                onMouseEnter={() => setKmc(true)}
                onMouseLeave={() => setKmc(false)}
                onClick={() => {
                  setSidebarOpen((v) => !v);
                  setKmc(false);
                }}
              />
            </StartButton>
            {/* Keep keyboard focus visible even over the glow */}
              <span
                className="absolute inset-0"
                onFocus={(e) => e.currentTarget.parentElement?.focus()}
                onBlur={(e) => e.currentTarget.parentElement?.blur()}
                style={{ outline: "none" }}
              />
            </div>
          )}
        </div>
      </aside>

      {/* Mobile drawer — unchanged */}
      <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
        <SheetContent
          side="left"
          className="w-72 border-r-2 border-ink bg-navy p-0 text-paper"
        >
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <div className="flex items-center justify-between border-b-2 border-paper/20 px-4 py-4">
            <BrandWordmark className="block" />
            <button onClick={() => setDrawerOpen(false)} aria-label="Close">
              <X className="size-5" />
            </button>
          </div>
          <div className="overflow-y-auto p-3">
            <NavList
              pathname={location.pathname}
              onNavigate={() => setDrawerOpen(false)}
              allowed={allowed}
              approvalsBadge={notifications?.unread ?? 0}
            />

            <Button
              variant="destructive"
              size="sm"
              className="mt-4 w-full"
              onClick={() => void signOut().then(() => navigate("/auth"))}
            >
              <LogOut className="size-4" /> Sign out
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      {/* Content column — width adjusts to desktop sidebar state via the
          existing transition-[padding] class; no horizontal overflow is
          introduced because the content column is constrained to a max-width
          and the sidebar shift is purely visual padding. */}
      <div
        className={cn(
          "transition-[padding] duration-300 ease-in-out lg:pl-64",
          sidebarOpen && "lg:pointer-events-none lg:opacity-0 lg:relative lg:translate-x-[-2px]",
        )}
      >

      {/* Content column */}
      <div
        className={cn(
          "transition-[padding] duration-300 ease-in-out lg:pl-64",
          sidebarOpen && "lg:pointer-events-none lg:opacity-0 lg:relative lg:translate-x-[-2px]",
        )}
      >
        <header className="sticky top-0 z-30 flex items-center gap-3 border-b-2 border-ink bg-card px-3 py-3 lg:px-6">
          <button
            className="grid size-10 place-items-center border-2 border-ink bg-white shadow-hard-sm lg:hidden"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open menu"
          >
            <Menu className="size-4" />
          </button>
          {/* Desktop sidebar expand/collapse toggle */}
          <button
            className="hidden size-10 place-items-center border-2 border-ink bg-white shadow-hard-sm active:translate-x-[2px] active:translate-y-[2px] active:shadow-none lg:grid"
            onClick={() => {
              setSidebarOpen((v) => !v);
              setKmc(false);
            }}
            aria-label={sidebarOpen ? "Hide menu and show tagline" : "Show menu and hide tagline"}
            aria-expanded={!sidebarOpen}
            aria-controls="desktop-sidebar"
          >
            <span
              className="relative inline-flex items-center justify-center w-12 h-12"
              style={{ background: "#F07800", boxShadow: "0 2px 8px rgba(240,120,0,0.45)", borderRadius: "0.375rem" }}
              aria-hidden="true"
            >
              {sidebarOpen ? (
                <PanelLeftOpen className="size-5 text-white" />
              ) : (
                <PanelLeftClose className="size-5 text-white" />
              )}
            </span>
          </button>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-black uppercase tracking-tight lg:text-lg">
              {title}
            </h1>
            <p className="truncate text-[11px] font-bold text-muted-foreground">
              {profile?.branch?.name ?? "Organization-wide"} ·{" "}
              {profile?.role?.replace("_", " ").toLowerCase()}
            </p>
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
          {/* Account dropdown — profile info, account links and logout live
              here; no separate always-visible logout button in the header. */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="flex items-center gap-2 border-2 border-ink bg-white px-2 py-1.5 shadow-hard-sm active:translate-x-[2px] active:translate-y-[2px] active:shadow-none"
                aria-label="Account menu"
              >
                <span className="grid size-8 shrink-0 place-items-center border-2 border-ink bg-gold text-xs font-black text-ink">
                  {initials(profile?.name)}
                </span>
                <span className="hidden min-w-0 text-left sm:block">
                  <span className="block max-w-[160px] truncate text-xs font-black">
                    {profile?.name}
                  </span>
                  <span className="block max-w-[160px] truncate font-mono text-[10px] font-bold uppercase text-muted-foreground">
                    {profile?.staffId}
                    {profile?.branch?.code ? ` · ${profile.branch.code}` : ""}
                  </span>
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
            onChange={(e) => setQ(e.target.value)}
            placeholder="C-000128, LN-000001, Rahul…"
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

      {profile?.status && profile.status !== "ACTIVE" && (
        <div className="fixed inset-x-0 bottom-0 z-50 flex items-center justify-between gap-3 border-t-2 border-ink bg-destructive px-4 py-2 text-xs font-black uppercase text-white">
          <span>Account {profile.status} — actions are blocked</span>
          <Loader2 className="size-4 animate-spin" />
        </div>
      )
    </div>
  );
}

export { Logo };
