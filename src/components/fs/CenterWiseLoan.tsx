import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Money,
  MoneyInput,
  RowSkeleton,
  SectionTitle,
  StatusChip,
} from "@/components/fs/primitives";
import { MeetingSchedulePicker } from "@/components/fs/MeetingSchedulePicker";
import { Button } from "@/components/ui/button";
import { fmtId } from "@/lib/utils";
import {
  formatMeetingDate,
  formatMeetingDateShort,
  type MeetingDay,
} from "@/lib/meeting";
import { addPeriods } from "@/lib/finance/schedule";
import { useMutation, useQuery } from "convex/react";
import { Check, CheckCircle2, Search, Users } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";

/**
 * Centre-Wise Loan Disbursement — the PRIMARY path of the New Loan flow.
 *
 * SEARCH ONLY: the screen lists nothing by default — no centres, no member
 * counts, no client rows. The user enters a unique six-digit Center ID
 * (e.g. 257510) and/or a
 * Client ID and presses Search; the BACKEND resolves and filters the records
 * (the browser never receives the full directory to hide). The Center ID is
 * a unique six-digit number (e.g. 257510) and/or a Client ID; a search needs at
 * least one field, matches only what was asked for, and results appear only
 * after a successful search.
 *
 * From there the existing workflow is untouched: pick members, review the
 * batch, confirm — the backend then creates ONE SUBMITTED application per
 * selected client through the same policy engine and duplicate guards as a
 * single loan. Nothing is approved or disbursed here; the existing approval
 * workflow (authorised approvers, wallet limits, cash controls) decides next.
 */
export function CenterWiseLoan() {
  const navigate = useNavigate();

  // — Search (the only entry point; nothing is fetched before it) —
  const [centerIdInput, setCenterIdInput] = useState("");
  const [clientCodeInput, setClientCodeInput] = useState("");
  const [searchParams, setSearchParams] = useState<{
    code: string;
    clientCode: string;
  } | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);

  // — Batch —
  const [amountStr, setAmountStr] = useState("");
  // MANUAL centre meeting schedule. Both values are the Admin's / Branch
  // Manager's own choice: nothing is pre-selected and nothing is derived from
  // the disbursement date or from each other.
  const [meetingDay, setMeetingDay] = useState<MeetingDay | null>(null);
  const [firstMeetingDate, setFirstMeetingDate] = useState<number | null>(null);
  const meetingReady = meetingDay !== null && firstMeetingDate !== null;
  const firstInstallmentDate =
    firstMeetingDate !== null
      ? addPeriods(firstMeetingDate, "WEEKLY", 1)
      : null;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<
    Awaited<ReturnType<typeof submitBatch>> | null
  >(null);

  const amount = Number(amountStr || 0);

  // Backend-filtered search — runs only once a Search was submitted.
  const search = useQuery(api.loans.centerSearch, searchParams ?? "skip");
  const results = searchParams !== null && search?.matched ? search : null;
  const noMatch =
    searchParams !== null && search !== undefined && !search.matched;

  // Roster for the matched centre — resolved server-side; a Client-ID search
  // narrows it to that one member, so no unrelated clients are fetched.
  const rosterArgs = useMemo(() => {
    if (!searchParams || !search || !search.matched || !search.center) {
      return "skip" as const;
    }
    const base: {
      centerId: Id<"centers">;
      amount?: number;
      onlyClientIds?: Id<"clients">[];
    } = { centerId: search.center._id };
    if (amount > 0) base.amount = amount;
    if (search.client) base.onlyClientIds = [search.client._id];
    return base;
  }, [searchParams, search, amount]);
  const roster = useQuery(api.loans.centerRoster, rosterArgs);
  const submitBatch = useMutation(api.loans.submitCenterBatch);

  const onSearch = () => {
    const code = centerIdInput.trim();
    const clientCode = clientCodeInput.trim();
    if (!code && !clientCode) {
      setSearchError("Please enter a Center ID or Client ID to search.");
      return;
    }
    setSearchError(null);
    setSelected(new Set());
    setResult(null);
    setConfirming(false);
    setSearchParams({ code, clientCode });
  };

  const selectedRows = (roster?.rows ?? []).filter(
    (r) => r.eligible && selected.has(r.client._id),
  );
  const totalPrincipal = selectedRows.reduce((s, r) => s + (r.amount ?? 0), 0);
  const totalFees = selectedRows.reduce((s, r) => s + (r.charges ?? 0), 0);

  const toggle = (clientId: string, eligible: boolean) => {
    // Selection stays closed until the amount has been entered, the server
    // has scored the row against the policy, and the manual meeting day +
    // first meeting date have both been chosen.
    if (!eligible || !roster?.scored || !meetingReady) return;
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(clientId)) next.delete(clientId);
      else next.add(clientId);
      return next;
    });
  };

  const eligibleRows = roster?.scored
    ? roster.rows.filter((r) => r.eligible)
    : [];
  const selectAll = () => {
    setSelected(new Set(eligibleRows.map((r) => r.client._id)));
  };
  const clearSelection = () => setSelected(new Set());

  const centerDbId = roster?.center._id ?? null;

  const onConfirm = async () => {
    if (!centerDbId || amount <= 0) return;
    if (!meetingDay || firstMeetingDate === null) {
      toast.error("Select the centre meeting day and first meeting date first.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await submitBatch({
        centerId: centerDbId,
        amount,
        clientIds: [...selected] as Id<"clients">[],
        device: typeof navigator !== "undefined" ? navigator.userAgent.slice(0, 60) : undefined,
        // Both selections are persisted on EVERY loan of this batch.
        meetingDay,
        firstMeetingDate,
      });
      setConfirming(false);
      setResult(res);
      setSelected(new Set());
      if (res.createdCount > 0) {
        toast.success(
          `${res.createdCount} loan request(s) submitted for approval`,
        );
      }
      if (res.createdCount === 0) {
        toast.error("No loan requests were created — see the batch report.");
      } else if (res.skippedCount > 0) {
        toast.warning(
          `${res.skippedCount} client(s) skipped — see the batch report.`,
        );
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Batch submission failed");
    } finally {
      setSubmitting(false);
    }
  };

  const sectionLabel =
    "text-xs font-black uppercase tracking-[0.14em] text-muted-foreground";
  const inputCls =
    "h-11 w-full border-2 border-ink bg-white px-3 text-sm font-bold outline-none placeholder:text-muted-foreground";

  return (
    <div className="space-y-4">
      {/* 1 — SEARCH: the only thing on screen until a search succeeds. */}
      <section className="space-y-2 border-2 border-ink bg-card p-4 shadow-hard-sm">
        <h2 className={sectionLabel}>1 · Search centre or client</h2>
        <p className="border-2 border-ink bg-sky p-2 text-[11px] font-bold">
          Enter a Center ID or Client ID, then press Search — nothing is
          listed until you search.
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="block space-y-1">
            <span className="block text-[10px] font-black uppercase tracking-[0.14em] text-muted-foreground">
              Center ID
            </span>
            <input
              value={centerIdInput}
              onChange={(e) => setCenterIdInput(e.target.value)}
              placeholder="e.g. 257510"
              aria-label="Center ID"
              className={inputCls}
            />
          </label>
          <label className="block space-y-1">
            <span className="block text-[10px] font-black uppercase tracking-[0.14em] text-muted-foreground">
              Client ID
            </span>
            <input
              value={clientCodeInput}
              onChange={(e) => setClientCodeInput(e.target.value)}
              placeholder="e.g. 000137"
              aria-label="Client ID"
              className={inputCls}
            />
          </label>
        </div>
        <Button className="w-full" onClick={onSearch}>
          <Search /> Search
        </Button>

        {searchError && (
          <p
            role="alert"
            className="border-2 border-ink bg-blush p-2 text-[11px] font-black uppercase"
          >
            {searchError}
          </p>
        )}
        {noMatch && (
          <p className="border-2 border-ink bg-blush p-2 text-[11px] font-black uppercase">
            No matching center or client found.
          </p>
        )}
        {searchParams !== null && search === undefined && (
          <RowSkeleton rows={2} />
        )}
      </section>

      {/* Matched centre card + (optional) matched client card. */}
      {results && (
        <section className="space-y-2 border-2 border-ink bg-card p-4 shadow-hard-sm">
          <h2 className={sectionLabel}>Match</h2>
          {results.center ? (
            <div className="border-2 border-ink bg-white p-3 shadow-hard-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate text-sm font-black">
                  {results.center.name}
                </span>
                <span className="shrink-0 border-2 border-ink bg-navy px-2 py-0.5 font-mono text-[10px] font-black text-gold">
                  {fmtId(results.center.code)}
                </span>
              </div>
              <div className="mt-1 text-[11px] font-semibold text-muted-foreground">
                {results.center.village || "—"} · {results.center.clientCount}{" "}
                member{results.center.clientCount === 1 ? "" : "s"}
              </div>
            </div>
          ) : (
            <p className="border-2 border-dashed border-ink p-3 text-center text-xs font-bold text-muted-foreground">
              This client has no centre linked — centre-wise disbursement
              needs a centre. Use a Single Client Loan instead.
            </p>
          )}
          {results.client && (
            <div className="border-2 border-ink bg-white p-3 shadow-hard-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-black">
                  {results.client.name}
                </span>
                <span className="font-mono text-[11px] font-bold text-muted-foreground">
                  {fmtId(results.client.code)}
                </span>
                <StatusChip
                  label={results.client.kycStatus}
                  tone={
                    results.client.kycStatus === "VERIFIED"
                      ? "ok"
                      : results.client.kycStatus === "REJECTED"
                        ? "bad"
                        : "warn"
                  }
                />
              </div>
              <div className="mt-1 text-[11px] font-semibold text-muted-foreground">
                {results.client.village || "—"} ·{" "}
                {results.client.activeLoans} active loan
                {results.client.activeLoans === 1 ? "" : "s"}
                {results.client.status !== "ACTIVE"
                  ? ` · ${results.client.status.toLowerCase()}`
                  : ""}
              </div>
            </div>
          )}
        </section>
      )}

      {/* 2 — loan amount: appears only once a search has matched. Terms are
          fixed by the backend (78.5% reducing, 24 weekly, no product). */}
      {results && (
        <section className="space-y-3 border-2 border-ink bg-card p-4 shadow-hard-sm">
          <h2 className={sectionLabel}>2 · Loan amount (each member)</h2>
          <MoneyInput value={amountStr} onChange={setAmountStr} label="Loan amount" />

          {/* Attendance schedule — selected MANUALLY, right below the amount, and
              before the member list can be used. */}
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

          <p className="border-2 border-ink bg-sky p-2 text-[11px] font-bold">
            Every loan in this batch uses the fixed backend terms — 78.5% p.a.
            reducing balance · 24 weekly installments · no processing fee. Only
            the principal below is an input.
          </p>
        </section>
      )}

      {/* 3 — members: heading and rows appear only after a successful search
          that resolved a centre. */}
      {results?.center && (
        <section className="space-y-2 border-2 border-ink bg-card p-4 shadow-hard-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className={sectionLabel}>3 · Members</h2>
            {roster?.scored && roster.rows.length > 0 && (
              <div className="flex gap-1.5">
                <button
                  onClick={selectAll}
                  disabled={eligibleRows.length === 0 || !meetingReady}
                  className="border-2 border-ink bg-mint px-2.5 py-1.5 text-[10px] font-black uppercase shadow-hard-sm disabled:opacity-50"
                >
                  Select all eligible ({eligibleRows.length})
                </button>
                <button
                  onClick={clearSelection}
                  disabled={selected.size === 0}
                  className="border-2 border-ink bg-white px-2.5 py-1.5 text-[10px] font-black uppercase shadow-hard-sm disabled:opacity-50"
                >
                  Clear
                </button>
              </div>
            )}
          </div>

          {roster === undefined ? (
            <RowSkeleton rows={4} />
          ) : roster.rows.length === 0 ? (
            <p className="border-2 border-dashed border-ink p-3 text-center text-xs font-bold text-muted-foreground">
              No clients are linked to {roster.center.name} yet.
            </p>
          ) : (
            <>
              {!roster.scored && (
                <p className="border-2 border-ink bg-sky p-2 text-[11px] font-bold">
                  Enter the loan amount in step 2 to score these members
                  against the policy before selecting them.
                </p>
              )}
              {roster.scored && !meetingReady && (
                <p className="border-2 border-ink bg-gold p-2 text-[11px] font-black uppercase">
                  Select the center meeting day and the first meeting date in
                  step 2 before choosing members.
                </p>
              )}
              <div className="flex flex-col gap-2">
                {roster.rows.map((r) => {
                  const checked = selected.has(r.client._id);
                  const selectable = r.eligible && roster.scored && meetingReady;
                  return (
                    <div
                      key={r.client._id}
                      className={
                        "flex items-start gap-3 border-2 border-ink p-2.5 shadow-hard-sm " +
                        (selectable
                          ? checked
                            ? "bg-gold"
                            : "bg-white"
                          : "bg-muted")
                      }
                    >
                      <button
                        type="button"
                        role="checkbox"
                        aria-checked={checked}
                        aria-label={`Select ${r.client.name}`}
                        disabled={!selectable}
                        onClick={() => toggle(r.client._id, r.eligible)}
                        className="mt-0.5 grid size-6 shrink-0 place-items-center border-2 border-ink bg-white disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {checked && <Check className="size-4" />}
                      </button>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-black">{r.client.name}</span>
                          <span className="font-mono text-[11px] font-bold text-muted-foreground">
                            {fmtId(r.client.code)}
                          </span>
                          <StatusChip
                            label={r.client.kycStatus}
                            tone={
                              r.client.kycStatus === "VERIFIED"
                                ? "ok"
                                : r.client.kycStatus === "REJECTED"
                                  ? "bad"
                                  : "warn"
                            }
                          />
                          {r.pendingApplication && (
                            <StatusChip
                              label={`Pending ${fmtId(r.pendingApplication.appId)}`}
                              tone="warn"
                            />
                          )}
                        </div>
                        <div className="mt-0.5 text-[11px] font-semibold text-muted-foreground">
                          {r.client.village} · {r.activeLoans} active loan
                          {r.activeLoans === 1 ? "" : "s"}
                          {r.overdueHistory > 0
                            ? ` · overdue history ${r.overdueHistory}`
                            : ""}
                        </div>
                        {r.amount != null && r.amount > 0 && (
                          <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] font-bold">
                            <span>
                              Loan <Money value={r.amount} className="text-[11px]" />
                            </span>
                            <span>
                              Fee <Money value={r.charges ?? 0} className="text-[11px]" />
                            </span>
                            <span>
                              Installment{" "}
                              <Money
                                value={r.installment ?? 0}
                                className="text-[11px]"
                              />
                            </span>
                          </div>
                        )}
                        {r.blockers.map((b, i) => (
                          <p
                            key={`b${i}`}
                            className="mt-1 border-2 border-ink bg-blush px-2 py-1 text-[10px] font-black uppercase"
                          >
                            {b}
                          </p>
                        ))}
                        {r.warnings.map((w, i) => (
                          <p
                            key={`w${i}`}
                            className="mt-1 border-2 border-ink bg-gold px-2 py-1 text-[10px] font-black uppercase"
                          >
                            {w}
                          </p>
                        ))}
                      </div>
                      <StatusChip
                        label={
                          !roster.scored
                            ? "Awaiting amount"
                            : r.eligible
                              ? "Eligible"
                              : "Blocked"
                        }
                        tone={!roster.scored ? "warn" : r.eligible ? "ok" : "bad"}
                        className="shrink-0"
                      />
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </section>
      )}

      {/* 4 — review */}
      {roster?.scored && meetingReady && selectedRows.length > 0 && (
        <section className="space-y-3 border-2 border-ink bg-navy p-4 text-paper shadow-hard">
          <div className="text-[10px] font-black uppercase tracking-[0.18em] text-gold">
            4 · Review the batch
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="border-2 border-paper/30 p-2">
              <div className="text-[9px] font-black uppercase text-paper/60">
                Centre
              </div>
              <div className="text-sm font-black">                  {roster.center.name} ({fmtId(roster.center.code)})
              </div>
            </div>
            <div className="border-2 border-paper/30 p-2">
              <div className="text-[9px] font-black uppercase text-paper/60">
                Members selected
              </div>
              <div className="text-lg font-black">{selectedRows.length}</div>
            </div>
            <div className="border-2 border-paper/30 p-2">
              <div className="text-[9px] font-black uppercase text-paper/60">
                Total proposed disbursement
              </div>
              <Money value={totalPrincipal} className="text-lg" />
            </div>
            <div className="border-2 border-paper/30 p-2">
              <div className="text-[9px] font-black uppercase text-paper/60">
                Processing fees
              </div>
              <Money value={totalFees} className="text-lg" />
            </div>
            <div className="col-span-2 border-2 border-paper/30 p-2">
              <div className="text-[9px] font-black uppercase text-paper/60">
                Centre schedule — saved on every loan
              </div>
              <div className="text-sm font-black">
                Center Meeting Day: {meetingDay ?? "—"} · First Meeting Date:{" "}
                {formatMeetingDate(firstMeetingDate)}
              </div>
              {firstInstallmentDate !== null && (
                <div className="text-[11px] font-bold text-paper/80">
                  First installment due {" "}
                  {formatMeetingDateShort(firstInstallmentDate)} · then weekly on{" "}
                  {meetingDay}
                </div>
              )}
            </div>
            <div className="col-span-2 border-2 border-paper/30 p-2">
              <div className="text-[9px] font-black uppercase text-paper/60">
                Terms — each client
              </div>
              <div className="text-sm font-black">
                ₹{amount.toLocaleString("en-IN")} principal ·{" "}
                {roster.terms.interestRate}%{" "}
                {roster.terms.interestMethod.toLowerCase()} ·{" "}
                {roster.terms.tenure} {roster.terms.frequency.toLowerCase()}{" "}
                installments · fee ₹
                {(selectedRows[0]?.charges ?? 0).toLocaleString("en-IN")} ·
                installment ₹
                {(selectedRows[0]?.installment ?? 0).toLocaleString("en-IN")}
              </div>
            </div>
          </div>

          <div className="max-h-48 overflow-y-auto border-2 border-paper/30">
            {selectedRows.map((r) => (
              <div
                key={r.client._id}
                className="flex items-center justify-between gap-2 border-b border-paper/10 px-2 py-1.5 text-[11px] font-bold last:border-0"
              >
                <span className="min-w-0 truncate">
                  {r.client.name}{" "}
                  <span className="font-mono text-muted-foreground">
                    {fmtId(r.client.code)}
                  </span>
                </span>
                <span className="shrink-0 font-mono tabular-nums">
                  ₹{(r.amount ?? 0).toLocaleString("en-IN")} + fee ₹
                  {(r.charges ?? 0).toLocaleString("en-IN")}
                </span>
              </div>
            ))}
          </div>

          <p className="border-2 border-ink bg-gold p-2 text-[11px] font-black uppercase text-ink">
            Submitting creates one pending loan request per member — nothing is
            approved or disbursed here. Approvers, wallet limits and cash
            controls apply exactly as for a single loan.
          </p>

          <Button size="lg" className="w-full" onClick={() => setConfirming(true)}>
            <CheckCircle2 /> Review & confirm {selectedRows.length} loan
            {selectedRows.length === 1 ? "" : "s"}
          </Button>
        </section>
      )}

      {/* Batch report — accurate partial-failure reporting. */}
      {result && (
        <section className="space-y-3 border-2 border-ink bg-card p-4 shadow-hard-sm">
          <SectionTitle>
            Batch report — {result.centerName} ({fmtId(result.centerCode)})
          </SectionTitle>
          <p className="border-2 border-ink bg-sky p-2 text-[11px] font-bold">
            Every loan in this batch carries Center Meeting Day {" "}
            <span className="font-black">{meetingDay ?? "—"}</span> and First
            Meeting Date {" "}
            <span className="font-black">{formatMeetingDate(firstMeetingDate)}</span>.
          </p>
          {result.createdCount > 0 && (
            <div>
              <p className="mb-1 text-[10px] font-black uppercase text-muted-foreground">
                Submitted for approval ({result.createdCount})
              </p>
              <div className="flex flex-col gap-1">
                {result.created.map((c) => (
                  <div
                    key={c.appId}
                    className="flex items-center justify-between gap-2 border-2 border-ink bg-mint px-2 py-1.5 text-[11px] font-bold"
                  >
                    <span className="min-w-0 truncate">
                      {c.name}{" "}
                      <span className="font-mono text-muted-foreground">
                        {fmtId(c.code)}
                      </span>
                    </span>
                    <span className="font-mono font-black">{fmtId(c.appId)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {result.skippedCount > 0 && (
            <div>
              <p className="mb-1 text-[10px] font-black uppercase text-destructive">
                Skipped ({result.skippedCount})
              </p>
              <div className="flex flex-col gap-1">
                {result.skipped.map((s) => (
                  <div
                    key={s.clientId}
                    className="border-2 border-ink bg-blush px-2 py-1.5 text-[11px] font-bold"
                  >
                    <span className="font-black">{s.name}</span>{" "}
                    <span className="font-mono">({fmtId(s.code)})</span> — {s.reason}
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="flex gap-2">
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => setResult(null)}
            >
              Start another batch
            </Button>
            <Button
              className="flex-1"
              onClick={() => navigate("/dashboard/approvals")}
            >
              <Users className="size-4" /> Go to approvals
            </Button>
          </div>
        </section>
      )}

      {/* Confirmation — required before anything is written. */}
      {confirming && roster && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4">
          <div className="w-full max-w-sm border-2 border-ink bg-card p-4 shadow-hard">
              <h3 className="text-lg font-black uppercase tracking-tight">
                Confirm centre-wise batch
              </h3>
              <p className="mt-2 text-sm font-semibold">
                Create <span className="font-black">{selectedRows.length}</span>{" "}
                loan request(s) of{" "}
                <span className="font-black">
                  ₹{amount.toLocaleString("en-IN")}
                </span>{" "}
                each for members of{" "}
                <span className="font-black">
                  {roster.center.name} ({fmtId(roster.center.code)})
                </span>{" "}
                at {roster.terms.interestRate}% reducing balance over{" "}
                {roster.terms.tenure} weekly installments? Each request goes to
                the approval queue.
              </p>
              <div className="mt-3 border-2 border-ink bg-sky p-2 text-[11px] font-bold">
                Total proposed disbursement ₹
                {totalPrincipal.toLocaleString("en-IN")} · fees ₹
                {totalFees.toLocaleString("en-IN")}
              </div>
              <div className="mt-2 border-2 border-ink bg-gold p-2 text-[11px] font-black uppercase">
                Center Meeting Day: {meetingDay} · First Meeting Date:{" "}
                {formatMeetingDate(firstMeetingDate)}
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <Button
                  variant="outline"
                  onClick={() => setConfirming(false)}
                  disabled={submitting}
                >
                  Cancel
                </Button>
                <Button
                  disabled={submitting || selectedRows.length === 0 || !meetingReady}
                  onClick={() => void onConfirm()}
                >
                  {submitting ? "Submitting…" : "Confirm"}
                </Button>
              </div>
          </div>
        </div>
      )}
    </div>
  );
}
