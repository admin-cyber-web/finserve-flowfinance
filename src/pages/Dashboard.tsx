import { AdminShell } from "@/app/AdminShell";
import { MobileShell } from "@/app/MobileShell";
import { Logo } from "@/components/fs/primitives";
import { Button } from "@/components/ui/button";
import { useProfile } from "@/hooks/use-profile";
import { Loader2, TriangleAlert } from "lucide-react";
import { Navigate, Route, Routes } from "react-router";

import AdminHome from "./dashboard/AdminHome";
import Approvals from "./dashboard/Approvals";
import Audit from "./dashboard/Audit";
import Accounting from "./dashboard/Accounting";
import Cash from "./dashboard/Cash";
import ClientDetail from "./dashboard/ClientDetail";
import ClientNew from "./dashboard/ClientNew";
import ClientHome from "./dashboard/ClientHome";
import Clients from "./dashboard/Clients";
import Collect from "./dashboard/Collect";
import Collection from "./dashboard/Collection";
import LoanDetail from "./dashboard/LoanDetail";
import LoanNew from "./dashboard/LoanNew";
import Loans from "./dashboard/Loans";
import Overdue from "./dashboard/Overdue";
import Profile from "./dashboard/Profile";
import Receipt from "./dashboard/Receipt";
import Reports from "./dashboard/Reports";
import Staff from "./dashboard/Staff";
import StaffDetail from "./dashboard/StaffDetail";
import StaffHome from "./dashboard/StaffHome";
import Transactions from "./dashboard/Transactions";
import Users from "./dashboard/Users";
import Branches from "./dashboard/Branches";
import Centres from "./dashboard/Centres";

function BootScreen({ label }: { label: string }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-5 bg-paper p-6">
      <div className="border-2 border-ink bg-navy px-5 py-4 shadow-hard">
        <Logo className="text-paper [&_span:last-child]:text-paper" />
      </div>
      <div className="flex items-center gap-2 text-xs font-black uppercase tracking-widest text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        {label}
      </div>
      <div className="flex gap-1.5">
        <span className="size-3 animate-pulse-block border-2 border-ink bg-gold" />
        <span
          className="size-3 animate-pulse-block border-2 border-ink bg-royal"
          style={{ animationDelay: "0.15s" }}
        />
        <span
          className="size-3 animate-pulse-block border-2 border-ink bg-mint"
          style={{ animationDelay: "0.3s" }}
        />
      </div>
    </main>
  );
}

function NoWorkspace() {
  const { user, signOut } = useProfile();
  return (
    <main className="flex min-h-screen items-center justify-center bg-paper p-6">
      <div className="w-full max-w-md border-2 border-ink bg-card p-6 text-center shadow-hard">
        <div className="mx-auto w-fit">
          <Logo />
        </div>
        <div className="mx-auto mt-4 grid size-12 place-items-center border-2 border-ink bg-gold">
          <TriangleAlert className="size-5" />
        </div>
        <h1 className="mt-3 text-lg font-black uppercase tracking-tight">
          No workspace linked
        </h1>
        <p className="mt-2 text-sm font-semibold text-muted-foreground">
          {user?.email ?? user?.name ?? "This account"} isn't linked to a KIRAT
          MICRO CREDIT workspace yet. Sign in with the email your administrator
          registered for your account.
        </p>
        <div className="mt-4 flex flex-col gap-2">
          <Button
            onClick={() => {
              void signOut().then(() => {
                window.location.href = "/auth";
              });
            }}
          >
            Switch account
          </Button>
          <Button variant="outline" onClick={() => (window.location.href = "/")}>
            Back to home
          </Button>
        </div>
      </div>
    </main>
  );
}

export default function Dashboard() {
  const { profile, loading } = useProfile();

  if (loading) {
    return <BootScreen label="Loading your workspace…" />;
  }

  if (!profile) {
    return <NoWorkspace />;
  }

  const isField = profile.role === "FIELD_STAFF";
  const home =
    profile.role === "FIELD_STAFF" ? (
      <StaffHome />
    ) : profile.role === "CLIENT" ? (
      <ClientHome />
    ) : (
      <AdminHome />
    );

  const inner = (
    <Routes>
      <Route index element={home} />
      <Route path="collect" element={<Collect />} />
      <Route path="clients" element={<Clients />} />
      <Route path="clients/new" element={<ClientNew />} />
      <Route path="clients/:id" element={<ClientDetail />} />
      <Route path="loans" element={<Loans />} />
      <Route path="loans/new" element={<LoanNew />} />
      <Route path="loans/:id" element={<LoanDetail />} />
      <Route path="transactions" element={<Transactions />} />
      <Route path="receipts/:number" element={<Receipt />} />
      <Route path="wallet" element={<Profile />} />
      <Route path="profile" element={<Profile />} />
      <Route path="cash" element={<Cash />} />
      <Route path="reports" element={<Reports />} />
      <Route path="approvals" element={<Approvals />} />
      <Route path="collection" element={<Collection />} />
      <Route path="staff" element={<Staff />} />
      <Route path="staff/:id" element={<StaffDetail />} />
      <Route path="users" element={<Users />} />
      <Route path="overdue" element={<Overdue />} />
      <Route path="accounting" element={<Accounting />} />
      <Route path="audit" element={<Audit />} />
      <Route path="branches" element={<Branches />} />
      <Route path="centres" element={<Centres />} />
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );

  const content = inner;

  if (isField) {
    return <MobileShell>{content}</MobileShell>;
  }
  return <AdminShell>{content}</AdminShell>;
}
