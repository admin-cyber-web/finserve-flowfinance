import { api } from "@/convex/_generated/api";
import {
  Money,
  PageHeader,
  RowSkeleton,
  SectionTitle,
  StatusChip,
  timeAgo,
} from "@/components/fs/primitives";
import { Button } from "@/components/ui/button";
import { useProfile } from "@/hooks/use-profile";
import { PERMISSION_LABELS, type Permission } from "@/lib/finance/permissions";
import { ROLE_LABELS, WALLET_TX_LABELS, type FsRole, type WalletTxType } from "@/lib/finance/types";
import { cn, fmtId } from "@/lib/utils";
import { useMutation, useQuery } from "convex/react";
import { LogOut, ShieldCheck, Smartphone, Wallet } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";

export default function Profile() {
  const { profile, user, permissions, signOut } = useProfile();
  const navigate = useNavigate();
  const wallet = useQuery(api.wallet.myWallet);
  const txns = useQuery(api.wallet.transactions, { limit: 50 });
  const sessions = useQuery(api.profiles.sessions, {});
  const revoke = useMutation(api.profiles.revokeOtherSessions);
  const [busy, setBusy] = useState(false);

  if (!profile) return <RowSkeleton rows={5} />;

  const initials = profile.name
    .split(" ")
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <div className="space-y-5 pb-8">
      {/* The designation is the stored role — never the effective authorizing
          role, so a backend-granted account still shows its own title. */}
      <PageHeader
        title="Profile"
        subtitle={ROLE_LABELS[(profile.designationRole ?? profile.role) as FsRole]}
      />

      {/* Identity */}
      <section className="border-2 border-ink bg-navy p-4 text-paper shadow-hard">
        <div className="flex items-center gap-3">
          <span className="grid size-14 shrink-0 place-items-center border-2 border-ink bg-gold text-xl font-black text-ink shadow-hard-sm">
            {initials}
          </span>
          <div className="min-w-0">
            <div className="truncate text-lg font-black leading-tight">{profile.name}</div>
            <div className="font-mono text-[11px] font-bold uppercase text-gold">
              {fmtId(profile.staffId)}
            </div>
            <div className="truncate text-[11px] font-semibold text-paper/70">
              {profile.branch?.name ?? "No branch"} · {user?.email ?? "signed-in session"}
            </div>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          <StatusChip status={profile.status} />
          <span className="border-2 border-paper/40 px-1.5 py-0.5 text-[10px] font-black uppercase">
            {ROLE_LABELS[(profile.designationRole ?? profile.role) as FsRole]}
          </span>
          <span className="border-2 border-paper/40 px-1.5 py-0.5 text-[10px] font-black uppercase">
            Joined {profile.joiningDate ? new Date(profile.joiningDate).toLocaleDateString("en-IN") : "—"}
          </span>
        </div>
      </section>

      {/* Wallet */}
      {wallet !== undefined && (
        <section>
          <SectionTitle>Working wallet</SectionTitle>
          {wallet === null ? (
            <div className="border-2 border-dashed border-ink/50 p-4 text-center text-xs font-bold text-muted-foreground">
              No field wallet on this account — wallets belong to field staff.
            </div>
          ) : (
            <div className="border-2 border-ink bg-gold p-4 shadow-hard">
              <div className="flex items-start justify-between">
                <div>
                  <div className="text-[10px] font-black uppercase text-ink/70">
                    Available balance
                  </div>
                  <Money value={wallet.balance} className="text-3xl" />
                </div>
                <Wallet className="size-6" />
              </div>
              <div className="mt-3 h-4 border-2 border-ink bg-paper">
                <div
                  className="h-full bg-royal"
                  style={{ width: `${Math.max(2, Math.min(100, wallet.utilization))}%` }}
                />
              </div>
              <div className="mt-1 flex justify-between text-[10px] font-black uppercase">
                <span>{Math.round(wallet.utilization)}% of limit used</span>
                <span>
                  Limit {wallet.limit.toLocaleString("en-IN")}
                </span>
              </div>
              {wallet.warning && (
                <div className="mt-2 border-2 border-ink bg-blush px-2 py-1 text-[11px] font-black uppercase">
                  ⚠ Low balance — request working cash from your BM
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {/* Wallet ledger */}
      {wallet !== undefined && wallet !== null && txns !== undefined && txns.length > 0 && (
        <section>
          <SectionTitle
            action={
              <button
                className="border-2 border-ink bg-white px-2 py-0.5 text-[10px] font-black uppercase shadow-hard-sm"
                onClick={() => navigate("/dashboard/transactions?tab=wallet")}
              >
                View all
              </button>
            }
          >
            Recent wallet ledger
          </SectionTitle>
          <div className="flex flex-col gap-1.5">
            {txns.slice(0, 8).map((t) => {
              const credit = t.direction === "CREDIT";
              const neutral = t.direction === "NONE";
              return (
                <div
                  key={t._id}
                  className="flex items-center justify-between gap-2 border-2 border-ink bg-card px-3 py-2 shadow-hard-sm"
                >
                  <div className="min-w-0">
                    <p className="truncate text-xs font-black">
                      {WALLET_TX_LABELS[t.type as WalletTxType] ?? t.type}
                    </p>
                    <p className="truncate text-[10px] font-semibold text-muted-foreground">
                      {fmtId(t.referenceId ?? t.txnId)} · {timeAgo(t.createdAt)}
                    </p>
                  </div>
                  <div className="text-right">
                    <Money
                      value={t.amount}
                      signed={!neutral}
                      className={cn(
                        "text-sm",
                        credit && "text-success",
                        !credit && !neutral && "text-destructive",
                      )}
                    />
                    <p className="text-[10px] font-black uppercase text-muted-foreground">
                      bal {t.balanceAfter.toLocaleString("en-IN")}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Permissions */}
      <section>
        <SectionTitle>Your permissions</SectionTitle>
        <div className="flex flex-wrap gap-1.5">
          {permissions.map((p) => (
            <span
              key={p}
              className="border-2 border-ink bg-mint px-2 py-1 text-[10px] font-black uppercase"
            >
              {PERMISSION_LABELS[p as Permission] ?? p}
            </span>
          ))}
        </div>
        <p className="mt-2 flex items-start gap-1.5 text-[11px] font-semibold text-muted-foreground">
          <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
          Permissions are enforced on the server — the UI only mirrors them.
        </p>
      </section>

      {/* Sessions */}
      <section>
        <SectionTitle>Sessions</SectionTitle>
        <div className="flex flex-col gap-1.5">
          {(sessions ?? []).map((d) => (
            <div
              key={d._id}
              className="flex items-center justify-between gap-2 border-2 border-ink bg-card px-3 py-2 shadow-hard-sm"
            >
              <span className="flex min-w-0 items-center gap-2">
                <Smartphone className="size-4 shrink-0" />
                <span className="truncate text-xs font-black">{d.label}</span>
              </span>
              <span className="shrink-0 text-[10px] font-black uppercase text-muted-foreground">
                {timeAgo(d.lastSeenAt)}
              </span>
            </div>
          ))}
          {(sessions ?? []).length === 0 && (
            <p className="text-xs font-semibold text-muted-foreground">No devices recorded.</p>
          )}
        </div>
        {sessions && sessions.length > 1 && (
          <Button
            variant="outline"
            size="sm"
            className="mt-2 w-full"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const result = await revoke({});
                toast.success(`${result.revoked} other session(s) revoked`);
              } catch (err) {
                toast.error(err instanceof Error ? err.message : "Could not revoke");
              } finally {
                setBusy(false);
              }
            }}
          >
            Sign out other devices
          </Button>
        )}
      </section>

      <Button
        variant="destructive"
        size="lg"
        className="w-full"
        onClick={() => void signOut().then(() => navigate("/"))}
      >
        <LogOut className="size-4" /> Sign out
      </Button>
    </div>
  );
}
