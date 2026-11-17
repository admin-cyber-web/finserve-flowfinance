import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  BottomSheet,
  KeyValue,
  Money,
  MoneyInput,
  PageHeader,
  RowSkeleton,
  SectionTitle,
} from "@/components/fs/primitives";
import { CenterWiseLoan } from "@/components/fs/CenterWiseLoan";
import { MeetingSchedulePicker } from "@/components/fs/MeetingSchedulePicker";
import { Button } from "@/components/ui/button";
import { fmtId } from "@/lib/utils";
import {
  formatMeetingDate,
  formatMeetingDateShort,
  type MeetingDay,
} from "@/lib/meeting";
import { useMutation, useQuery } from "convex/react";
import { CLIENT_IMAGE_REQUIRED_MESSAGE } from "@/lib/clientImage";
import { CheckCircle2, HandCoins, TriangleAlert, UserRound, Users } from "lucide-react";
import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";

export default function LoanNew() {
  const navigate = useNavigate();
  const [params] = useSearchParams();

  const [clientId, setClientId] = useState<Id<"clients"> | null>(
    (params.get("client") as Id<"clients"> | null) ?? null,
  );
  // Three states: the initial chooser shows ONLY the two options (no product
  // cards, no centre list, no member panel), then either the centre-wise
  // batch wizard or the original single-client wizard. Arriving with a
  // pre-selected client (Client 360° → "Give loan") opens the single path.
  const [mode, setMode] = useState<"CHOOSE" | "CENTER" | "SINGLE">(
    params.get("client") ? "SINGLE" : "CHOOSE",
  );
  const [amount, setAmount] = useState("");
  // MANUAL centre meeting schedule for this single loan — chosen by the
  // Admin / Branch Manager, never pre-filled, never auto-adjusted.
  const [meetingDay, setMeetingDay] = useState<MeetingDay | null>(null);
  const [firstMeetingDate, setFirstMeetingDate] = useState<number | null>(null);
  const meetingReady = meetingDay !== null && firstMeetingDate !== null;
  const [clientPicker, setClientPicker] = useState(false);
  const [clientSearch, setClientSearch] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // The client list belongs to the single-client path only — it is never
  // fetched (or shown) before an option has been chosen. There is no product
  // step: rate, frequency, tenure and fee are fixed backend terms.
  const single = mode === "SINGLE";
  const clients = useQuery(
    api.clients.list,
    single
      ? clientSearch.trim()
        ? { search: clientSearch.trim(), limit: 30 }
        : { limit: 30 }
      : "skip",
  );

  // Actual saved-image status for the selected client. Reactive: the moment a
  // photograph is saved from the client's profile, this flips and the block
  // below disappears — no reload, no re-created application.
  const imageStatus = useQuery(
    api.clients.imageStatus,
    single && clientId ? { clientId } : "skip",
  );
  const imageBlocked = !!clientId && imageStatus !== undefined && imageStatus.available === false;

  const numericAmount = Number(amount || 0);
  const previewReady = !!clientId && numericAmount > 0 && !imageBlocked;
  const preview = useQuery(
    api.loans.preview,
    previewReady
      ? {
          clientId: clientId!,
          amount: numericAmount,
          // The selected meeting schedule drives the preview dates as well,
          // so what the user sees is what will be stored.
          meetingDay: meetingDay ?? undefined,
          firstMeetingDate: firstMeetingDate ?? undefined,
        }
      : "skip",
  );
  const submit = useMutation(api.loans.submit);

  const selectedClient = clients?.find((c) => c._id === clientId);

  const onSubmit = async () => {
    if (imageBlocked) {
      // The backend enforces this too — the message is shown verbatim.
      toast.error(CLIENT_IMAGE_REQUIRED_MESSAGE);
      return;
    }
    if (!previewReady || !preview) return;
    if (!meetingReady) {
      toast.error("Select the center meeting day and the first meeting date.");
      return;
    }
    if (!preview.eligibility.eligible) {
      const blocker = preview.eligibility.issues.find((i) => i.level === "BLOCKER");
      toast.error(blocker?.message ?? "Lender policy blocks this application.");
      return;
    }
    setSubmitting(true);
    try {
      const result = await submit({
        clientId: clientId!,
        amount: numericAmount,
        device: navigator.userAgent.slice(0, 60),
        // Persisted on the application and copied onto the loan at approval.
        meetingDay: meetingDay!,
        firstMeetingDate: firstMeetingDate!,
      });
      toast.success(`Application ${fmtId(result.appId)} submitted for approval`);
      navigate("/dashboard/loans");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Submission failed");
    } finally {
      setSubmitting(false);
    }
  };

  const modeSwitcher = (
    <>
      <PageHeader
        title="New loan"
        subtitle="Centre-wise disbursement or a single client — policy-checked before submission"
        back="/dashboard/loans"
      />

      {/* Mode chooser — centre-wise first and primary. */}
      <section className="space-y-2 border-2 border-ink bg-card p-3 shadow-hard-sm">
        <h2 className="text-xs font-black uppercase tracking-[0.14em] text-muted-foreground">
          How do you want to lend?
        </h2>
        <div className="grid gap-2 sm:grid-cols-2">
          <button
            onClick={() => setMode("CENTER")}
            className={
              "w-full border-2 border-ink p-3 text-left shadow-hard-sm transition-transform active:translate-x-[2px] active:translate-y-[2px] active:shadow-none " +
              (mode === "CENTER" ? "bg-gold" : "bg-white")
            }
          >
            <span className="flex items-center gap-2 text-sm font-black uppercase">
              <Users className="size-4" /> Center-Wise Loan Disbursement
            </span>
            <span className="mt-1 block text-[11px] font-semibold text-muted-foreground">
              Primary path — create loan requests for every eligible member of
              one centre in a single batch, straight through the normal
              approval workflow.
            </span>
          </button>
          <button
            onClick={() => setMode("SINGLE")}
            className={
              "w-full border-2 border-ink p-3 text-left shadow-hard-sm transition-transform active:translate-x-[2px] active:translate-y-[2px] active:shadow-none " +
              (mode === "SINGLE" ? "bg-gold" : "bg-white")
            }
          >
            <span className="flex items-center gap-2 text-sm font-black uppercase">
              <HandCoins className="size-4" /> Single Client Loan
            </span>
            <span className="mt-1 block text-[11px] font-semibold text-muted-foreground">
              One borrower at a time through the existing application,
              approval and disbursement flow.
            </span>
          </button>
        </div>
      </section>
    </>
  );

  // Initial screen — and nothing else: exactly two choices.
  if (mode === "CHOOSE") {
    return <div className="space-y-4 pb-10">{modeSwitcher}</div>;
  }

  // Centre-wise path — the batch wizard lives in its own component.
  if (mode === "CENTER") {
    return (
      <div className="space-y-4 pb-10">
        {modeSwitcher}
        <CenterWiseLoan />
      </div>
    );
  }

  return (
    <div className="space-y-4 pb-10">
      {modeSwitcher}

      {/* Step 1 — client */}
      <section className="space-y-2 border-2 border-ink bg-card p-4 shadow-hard-sm">
        <h2 className="text-xs font-black uppercase tracking-[0.14em] text-muted-foreground">
          1 · Client
        </h2>
        <button
          onClick={() => setClientPicker(true)}
          className="flex w-full items-center justify-between gap-2 border-2 border-ink bg-white px-3 py-3 text-left shadow-hard-sm"
        >
          <span className="min-w-0">
            <span className="block truncate text-sm font-black">
              {selectedClient?.name ?? "Select client"}
            </span>
            {selectedClient && (
              <span className="block text-[11px] font-semibold text-muted-foreground">
                {fmtId(selectedClient.code)} · {selectedClient.village} · household income ₹
                {selectedClient.householdIncome.toLocaleString("en-IN")}
              </span>
            )}
          </span>
          <span className="shrink-0 border-2 border-ink bg-sky px-2 py-1 text-[10px] font-black uppercase">
            Change
          </span>
        </button>

        {/* Image gate — no camera, no upload field, no geo dropdown here:
            this section only REPORTS the backend status and links to the
            client's profile, where the image is captured. */}
        {clientId && imageStatus === undefined && <RowSkeleton rows={1} />}
        {imageBlocked && (
          <div className="space-y-2 border-2 border-ink bg-blush p-3">
            <p className="flex items-start gap-2 text-[11px] font-black">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" />
              {CLIENT_IMAGE_REQUIRED_MESSAGE}
            </p>
            <Button
              variant="outline"
              className="w-full"
              onClick={() => navigate(`/dashboard/clients/${clientId}#client-image`)}
            >
              <UserRound className="size-4" /> Open Client Profile
            </Button>
          </div>
        )}
        {clientId && imageStatus?.available && (
          <div className="flex items-center gap-2 border-2 border-ink bg-mint p-2 text-[11px] font-black uppercase">
            <CheckCircle2 className="size-4" /> Client Image Available — Proceed to Loan.
          </div>
        )}
      </section>

      {/* Step 2 — amount. Terms are fixed by the backend (78.5% reducing
          balance, 24 weekly installments) — there is no product to pick. */}
      <section className="space-y-3 border-2 border-ink bg-card p-4 shadow-hard-sm">
        <h2 className="text-xs font-black uppercase tracking-[0.14em] text-muted-foreground">
          2 · Amount
        </h2>
        <MoneyInput value={amount} onChange={setAmount} label="Loan amount" />

        {/* Manual centre meeting schedule — sits directly below the amount,
            before the schedule preview and the submit button. */}
        <MeetingSchedulePicker
          meetingDay={meetingDay}
          firstMeetingDate={firstMeetingDate}
          onChange={(next) => {
            if (next.meetingDay !== undefined) setMeetingDay(next.meetingDay);
            if (next.firstMeetingDate !== undefined) {
              setFirstMeetingDate(next.firstMeetingDate);
            }
          }}
        />

        <div className="border-2 border-ink bg-sky p-2 text-[11px] font-bold">
          Every new loan uses the same backend terms: 78.5% p.a. reducing
          balance · {preview?.tenure ?? 24} weekly installments · no
          processing fee applies.
        </div>
      </section>

      {/* Preview */}
      {!previewReady ? (
        <div className="border-2 border-dashed border-ink/50 p-4 text-center text-xs font-black uppercase text-muted-foreground">
          Select a client and enter an amount to see the schedule preview
        </div>
      ) : preview === undefined ? (
        <RowSkeleton rows={3} />
      ) : (
        <section className="space-y-3 border-2 border-ink bg-navy p-4 text-paper shadow-hard">
          <div className="text-[10px] font-black uppercase tracking-[0.18em] text-gold">
            Server-side policy preview
          </div>

          <div className="border-2 border-paper/30 p-2 text-[11px] font-bold">
            {meetingReady ? (
              <>
                Center Meeting Day:{" "}
                <span className="font-black">{meetingDay}</span> · First Meeting
                Date: <span className="font-black">{formatMeetingDate(firstMeetingDate)}</span>
              </>
            ) : (
              <>Pick a meeting day and a first meeting date above to anchor this schedule.</>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="border-2 border-paper/30 p-2">
              <div className="text-[9px] font-black uppercase text-paper/60">
                Installment
              </div>
              <Money value={preview.regularInstallment} className="text-lg" />
            </div>
            <div className="border-2 border-paper/30 p-2">
              <div className="text-[9px] font-black uppercase text-paper/60">
                Processing fee (none applies)
              </div>
              <Money value={preview.charges} className="text-lg" />
            </div>
            <div className="border-2 border-paper/30 p-2">
              <div className="text-[9px] font-black uppercase text-paper/60">
                Net disbursed
              </div>
              <Money value={preview.netDisbursed} className="text-lg" />
            </div>
            <div className="border-2 border-paper/30 p-2">
              <div className="text-[9px] font-black uppercase text-paper/60">
                Total interest
              </div>
              <Money value={preview.totalInterest} className="text-lg" />
            </div>
            <div className="col-span-2 border-2 border-paper/30 p-2">
              <div className="text-[9px] font-black uppercase text-paper/60">
                Total payable (principal + interest)
              </div>
              <Money value={preview.totalPayable} className="text-lg" />
            </div>
          </div>

          <div className="text-[11px] font-bold text-paper/80">
            Obligation ratio {preview.eligibility.obligationRatio}% of household
            income (existing {preview.existingObligations.toLocaleString("en-IN")} +
            proposed {preview.proposedMonthly.toLocaleString("en-IN")}/mo) ·{" "}
            {preview.activeLoans} active loan(s)
          </div>

          {preview.eligibility.issues.length > 0 && (
            <div className="flex flex-col gap-2">
              {preview.eligibility.issues.map((issue, i) => (
                <div
                  key={i}
                  className={
                    "flex items-start gap-2 border-2 border-ink p-2 text-[11px] font-bold text-ink " +
                    (issue.level === "BLOCKER" ? "bg-blush" : "bg-gold")
                  }
                >
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                  <span>
                    <span className="font-black uppercase">{issue.level} — </span>
                    {issue.message}
                  </span>
                </div>
              ))}
            </div>
          )}

          {preview.eligibility.eligible && (
            <div className="flex items-center gap-2 border-2 border-ink bg-mint p-2 text-[11px] font-black uppercase text-ink">
              <CheckCircle2 className="size-4" /> Eligible under lender policy
            </div>
          )}

          <div>
            <div className="mb-1 text-[10px] font-black uppercase tracking-[0.18em] text-gold">
              Repayment schedule ({preview.schedule.length} periods)
            </div>
            <div className="max-h-64 overflow-y-auto border-2 border-paper/30">
              <div className="grid grid-cols-[2rem_1fr_auto] gap-x-2 border-b-2 border-paper/30 bg-white/10 px-2 py-1 text-[10px] font-black uppercase">
                <span>#</span>
                <span>Due</span>
                <span>Amount</span>
              </div>
              {preview.schedule.map((row) => (
                <div
                  key={row.index}
                  className="grid grid-cols-[2rem_1fr_auto] gap-x-2 border-b border-paper/10 px-2 py-1 text-[11px] font-bold last:border-0"
                >
                  <span className="font-mono">{row.index}</span>
                  <span>
                    {formatMeetingDateShort(row.dueDate)}
                  </span>
                  <span className="font-mono tabular-nums">
                    ₹{row.totalDue.toLocaleString("en-IN")}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      <div className="sticky bottom-24 flex gap-2">
        <Button variant="outline" size="lg" className="flex-1" onClick={() => navigate(-1)}>
          Cancel
        </Button>
        <Button
          size="lg"
          className="flex-[2]"
          disabled={
            imageBlocked ||
            !previewReady ||
            !meetingReady ||
            !preview ||
            preview === undefined ||
            !preview.eligibility.eligible ||
            submitting
          }
          onClick={() => void onSubmit()}
        >
          {submitting ? "Submitting…" : "Submit for approval"}
        </Button>
      </div>

      {/* Client picker */}
      <BottomSheet
        open={clientPicker}
        onOpenChange={setClientPicker}
        title="Select client"
        subtitle="Pick the borrower for this application"
      >
        <input
          value={clientSearch}
          onChange={(e) => setClientSearch(e.target.value)}
          placeholder="Search name, code or mobile"
          className="mb-3 h-11 w-full border-2 border-ink bg-white px-3 text-sm font-bold outline-none"
        />
        <div className="flex flex-col gap-2">
          {clients === undefined && <RowSkeleton rows={3} />}
          {(clients ?? []).map((c) => (
            <button
              key={c._id}
              onClick={() => {
                setClientId(c._id);
                setClientPicker(false);
              }}
              className="border-2 border-ink bg-white p-2.5 text-left shadow-hard-sm"
            >
              <span className="block text-sm font-black">{c.name}</span>
              <span className="block text-[11px] font-semibold text-muted-foreground">
                {fmtId(c.code)} · {c.village} · {c.activeLoans} active loans
              </span>
            </button>
          ))}
        </div>
      </BottomSheet>

      {preview && (
        <SectionTitle className="sr-only">Preview summary</SectionTitle>
      )}
      <div className="sr-only">
        <KeyValue k="Client" v={selectedClient?.name ?? "—"} />
      </div>
    </div>
  );
}
