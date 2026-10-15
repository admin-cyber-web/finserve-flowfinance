import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  CopyableCode,
  EmptyState,
  KeyValue,
  Money,
  PageHeader,
  RowSkeleton,
  SectionTitle,
  StatusChip,
  formatDate,
  formatDateTime,
  timeAgo,
} from "@/components/fs/primitives";
import { Button } from "@/components/ui/button";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { useProfile } from "@/hooks/use-profile";
import { formatINR } from "@/lib/finance/money";
import { LOAN_STATUS_LABELS, RECOVERY_LABELS } from "@/lib/finance/types";
import { useMutation, useQuery } from "convex/react";
import {
  Camera,
  FileText,
  HandCoins,
  IndianRupee,
  MapPin,
  Navigation,
  NotebookPen,
  ShieldCheck,
  UserCheck,
} from "lucide-react";
import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import { toast } from "sonner";

export default function ClientDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { profile, can } = useProfile();
  const clientId = id as Id<"clients">;
  const data = useQuery(api.clients.get, { clientId });
  const geoPhoto = useQuery(api.clients.geoPhoto, { clientId });

  const addNote = useMutation(api.clients.addNote);
  const addDocument = useMutation(api.clients.addDocument);
  const decideDocument = useMutation(api.clients.decideDocument);
  const verifyKyc = useMutation(api.clients.verifyKyc);

  const [note, setNote] = useState("");
  const [docType, setDocType] = useState("KYC");
  const [docName, setDocName] = useState("");
  const [busy, setBusy] = useState(false);

  const canVerify =
    profile?.role === "SUPER_ADMIN" || profile?.role === "BRANCH_MANAGER";

  if (data === undefined) {
    return (
      <div className="space-y-3">
        <PageHeader title="Client 360°" back="/dashboard/clients" />
        <RowSkeleton rows={6} />
      </div>
    );
  }

  const { client, totals, loans, payments, documents, notes, activity, recovery, family, coApplicantPhotoUrl } =
    data;

  // Co-applicant uploads live alongside the application's documents; they are
  // rendered inside the Co-applicant card (Overview) rather than mixed into
  // the applicant's Docs list.
  const coApplicantDocs = documents.filter((d) => d.coApplicant);
  const ownDocs = documents.filter((d) => !d.coApplicant);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(ok);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title={client.name}
        subtitle={`${client.code} · ${client.village} · ${client.mobile}`}
        back="/dashboard/clients"
        action={<StatusChip status={client.kycStatus} label={`KYC ${client.kycStatus.toLowerCase()}`} />}
      />

      {/* Identity card */}
      <section className="border-2 border-ink bg-navy p-4 text-paper shadow-hard">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[10px] font-black uppercase tracking-[0.18em] text-gold">
              Outstanding
            </div>
            <Money value={totals.outstanding} className="text-3xl" />
          </div>
          <div className="text-right">
            <div className="text-[10px] font-black uppercase tracking-[0.18em] text-gold">
              Overdue
            </div>
            <Money
              value={totals.overdueAmount}
              className={`text-xl ${totals.overdueAmount > 0 ? "text-blush" : "text-paper"}`}
            />
          </div>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2 text-center">
          <div className="border-2 border-paper/30 p-1.5">
            <div className="text-[9px] font-black uppercase text-paper/60">Borrowed</div>
            <Money value={totals.totalBorrowed} className="text-sm" />
          </div>
          <div className="border-2 border-paper/30 p-1.5">
            <div className="text-[9px] font-black uppercase text-paper/60">Repaid</div>
            <Money value={totals.totalPaid} className="text-sm" />
          </div>
          <div className="border-2 border-paper/30 p-1.5">
            <div className="text-[9px] font-black uppercase text-paper/60">Loans</div>
            <span className="text-sm font-black">
              {totals.activeLoans}/{totals.activeLoans + totals.closedLoans}
            </span>
          </div>
        </div>
      </section>

      <div className="grid grid-cols-2 gap-2">
        <Button
          size="lg"
          onClick={() => navigate(`/dashboard/collect?client=${client._id}`)}
        >
          <IndianRupee /> Collect
        </Button>
        {can("create_loan") && (
          <Button
            size="lg"
            variant="outline"
            onClick={() => navigate(`/dashboard/loans/new?client=${client._id}`)}
          >
            <HandCoins /> Give loan
          </Button>
        )}
      </div>

      <Tabs defaultValue="overview">
        <TabsList className="h-auto w-full flex-wrap border-2 border-ink bg-white p-1">
          <TabsTrigger value="overview" className="flex-1 text-xs font-black uppercase">
            Overview
          </TabsTrigger>
          <TabsTrigger value="loans" className="flex-1 text-xs font-black uppercase">
            Loans ({loans.length})
          </TabsTrigger>
          <TabsTrigger value="payments" className="flex-1 text-xs font-black uppercase">
            Payments ({payments.length})
          </TabsTrigger>
          <TabsTrigger value="docs" className="flex-1 text-xs font-black uppercase">
            Docs ({ownDocs.length})
          </TabsTrigger>
          <TabsTrigger value="notes" className="flex-1 text-xs font-black uppercase">
            Notes ({notes.length})
          </TabsTrigger>
        </TabsList>

        {/* ------------------------------ OVERVIEW --------------------------- */}
        <TabsContent value="overview" className="mt-4 space-y-4">
          <section className="border-2 border-ink bg-card p-4 shadow-hard-sm">
            <KeyValue k="Father / husband" v={client.fatherName ?? "—"} />
            <KeyValue k="Age / gender" v={`${client.age} · ${client.gender.toLowerCase()}`} />
            <KeyValue k="Occupation" v={client.occupation} />
            <KeyValue k="Monthly income" v={<Money value={client.monthlyIncome} />} />
            <KeyValue k="Household income" v={<Money value={client.householdIncome} />} />
            <KeyValue k="Family members" v={String(client.familyMembers)} />
            <KeyValue k="Address" v={`${client.address ?? "—"}, ${client.district}, ${client.pin}`} />
            <KeyValue k="KYC doc" v={client.kycDocRef ? `${client.kycDocType}: ${client.kycDocRef}` : client.kycDocType ?? "—"} mono />
            <KeyValue k="Assigned staff" v={data.assignedStaff?.name ?? "—"} />
            {data.center && (
              <KeyValue
                k="Centre"
                v={`${data.center.code} · ${data.center.name}`}
                mono
              />
            )}
            <KeyValue k="Joined" v={formatDate(client.createdAt)} />
          </section>

          {/* Geo-tagged onboarding photo */}
          <section className="border-2 border-ink bg-card p-4 shadow-hard-sm">
            <SectionTitle
              action={<StatusChip label="Device GPS" tone="info" />}
            >
              Client photo & location
            </SectionTitle>
            {geoPhoto === undefined ? (
              <RowSkeleton rows={2} />
            ) : geoPhoto === null ? (
              <EmptyState
                title="No geo-tagged photo yet"
                hint="The client photo with GPS stamp is captured during onboarding."
                icon={<Camera className="size-5" />}
              />
            ) : (
              <div className="space-y-3">
                {geoPhoto.url && (
                  <img
                    src={geoPhoto.url}
                    alt={`Geo-tagged photo of ${client.name}`}
                    className="block w-full border-2 border-ink object-cover"
                  />
                )}
                <div className="font-mono text-xs font-bold">
                  <p>Latitude: {geoPhoto.latitude}</p>
                  <p>Longitude: {geoPhoto.longitude}</p>
                  <p>Accuracy: {Math.round(geoPhoto.accuracyMeters)} m</p>
                </div>
                <KeyValue k="Captured" v={formatDateTime(geoPhoto.capturedAt)} />
                <KeyValue
                  k="Photo uploaded"
                  v={`${formatDateTime(geoPhoto.uploadedAt)} · ${geoPhoto.status.toLowerCase()}`}
                />
                <p className="border-2 border-ink bg-sky p-2 text-[11px] font-bold">
                  Device-reported GPS capture at photo time — not an
                  independently verified location.
                </p>
                <div className="flex gap-2">
                  <Button variant="outline" className="flex-1" asChild>
                    <a
                      href={`https://www.google.com/maps?q=${geoPhoto.latitude},${geoPhoto.longitude}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <MapPin className="size-4" /> View on map
                    </a>
                  </Button>
                  <Button variant="outline" className="flex-1" asChild>
                    <a
                      href={`https://www.google.com/maps/dir/?api=1&destination=${geoPhoto.latitude},${geoPhoto.longitude}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <Navigation className="size-4" /> Navigate
                    </a>
                  </Button>
                </div>
              </div>
            )}
          </section>

          {/* Full saved application — applicant, co-applicant, family,
              income, loan request, bank, nominee, declaration, office use. */}
          <section className="space-y-3 border-2 border-ink bg-card p-4 shadow-hard-sm">
            <SectionTitle>Application</SectionTitle>
            <KeyValue k="Applicant name" v={client.name} />
            <KeyValue k="Husband name" v={client.husbandName ?? "—"} />
            <KeyValue k="Father name" v={client.fatherName ?? "—"} />
            <KeyValue k="Father's address" v={client.fatherAddress ?? "—"} />
            <KeyValue k="Date of birth" v={client.dob ? formatDate(client.dob) : "—"} />
            <KeyValue
              k="PAN / Voter ID"
              v={`${client.panNumber ?? "—"} · ${client.voterId ?? "—"}`}
              mono
            />
            <KeyValue
              k="KYC documents"
              v={
                client.kycDocuments && client.kycDocuments.length > 0
                  ? client.kycDocuments.join(", ")
                  : "—"
              }
            />
            <KeyValue k="Type of business" v={client.typeOfBusiness ?? client.occupation} />
            <KeyValue k="Business address" v={client.businessAddress ?? "—"} />
            <KeyValue
              k="Other income"
              v={
                client.otherIncome !== undefined
                  ? `₹${client.otherIncome.toLocaleString("en-IN")}`
                  : "—"
              }
            />
            <KeyValue
              k="Existing loan / EMI"
              v={
                client.existingLoanEmi !== undefined
                  ? `₹${client.existingLoanEmi.toLocaleString("en-IN")}`
                  : "—"
              }
            />

            {client.coApplicant && (
              <div className="border-2 border-ink bg-sky p-3">
                <div className="mb-2 text-[10px] font-black uppercase tracking-[0.14em]">
                  Co-applicant
                </div>
                {coApplicantPhotoUrl && (
                  <img
                    src={coApplicantPhotoUrl}
                    alt={`Co-applicant ${client.coApplicant.name}`}
                    className="mb-2 w-24 border-2 border-ink object-cover"
                  />
                )}
                <KeyValue k="Name" v={client.coApplicant.name} />
                <KeyValue k="Relationship" v={client.coApplicant.relationship} />
                <KeyValue
                  k="Age / gender"
                  v={
                    client.coApplicant.age !== undefined
                      ? `${client.coApplicant.age}${client.coApplicant.gender ? ` · ${client.coApplicant.gender.toLowerCase()}` : ""}`
                      : client.coApplicant.gender?.toLowerCase() ?? "—"
                  }
                />
                <KeyValue k="Mobile" v={client.coApplicant.mobile ?? "—"} mono />
                <KeyValue
                  k="Aadhaar / PAN / Voter"
                  v={`${client.coApplicant.aadhaarNumber ?? "—"} · ${client.coApplicant.panNumber ?? "—"} · ${client.coApplicant.voterId ?? "—"}`}
                  mono
                />
                <KeyValue k="Address" v={client.coApplicant.address ?? "—"} />
                {coApplicantDocs.length > 0 && (
                  <div className="mt-2 space-y-1.5">
                    <div className="text-[10px] font-black uppercase tracking-[0.14em]">
                      Documents ({coApplicantDocs.length})
                    </div>
                    {coApplicantDocs.map((d) => (
                      <div
                        key={d._id}
                        className="flex items-center justify-between gap-2 border border-ink bg-white px-2 py-1"
                      >
                        <span className="min-w-0 flex-1 truncate text-[11px] font-bold">
                          {(d.docKind ?? d.type).replace(/_/g, " ")} · {d.fileName}
                        </span>
                        {d.url && (
                          <a
                            href={d.url}
                            target="_blank"
                            rel="noreferrer"
                            className="shrink-0 border border-ink bg-gold px-1.5 py-0.5 text-[10px] font-black uppercase"
                          >
                            View
                          </a>
                        )}
                        <StatusChip status={d.status} className="shrink-0" />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div>
              <div className="mb-1 text-[10px] font-black uppercase tracking-[0.14em] text-muted-foreground">
                Family members ({family.length || client.familyMembers})
              </div>
              {family.length === 0 ? (
                <p className="text-sm font-semibold text-muted-foreground">—</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full border-2 border-ink text-xs">
                    <thead>
                      <tr className="bg-muted text-left text-[10px] font-black uppercase">
                        <th className="border border-ink px-1.5 py-1">S.No.</th>
                        <th className="border border-ink px-1.5 py-1">Member</th>
                        <th className="border border-ink px-1.5 py-1">Age</th>
                        <th className="border border-ink px-1.5 py-1">Relation</th>
                        <th className="border border-ink px-1.5 py-1">Occupation</th>
                      </tr>
                    </thead>
                    <tbody>
                      {family.map((m, i) => (
                        <tr key={m._id} className="font-semibold">
                          <td className="border border-ink px-1.5 py-1 font-black">
                            {i + 1}
                          </td>
                          <td className="border border-ink px-1.5 py-1">{m.name}</td>
                          <td className="border border-ink px-1.5 py-1">{m.age ?? "—"}</td>
                          <td className="border border-ink px-1.5 py-1">
                            {m.relationship}
                          </td>
                          <td className="border border-ink px-1.5 py-1">
                            {m.occupation ?? "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {client.loanRequest && (
              <div className="border-2 border-ink bg-white p-3">
                <div className="mb-2 text-[10px] font-black uppercase tracking-[0.14em]">
                  Loan request (not a loan — subject to approval)
                </div>
                <KeyValue
                  k="Amount requested"
                  v={<Money value={client.loanRequest.amountRequested} />}
                />
                <KeyValue k="Purpose" v={client.loanRequest.purpose.toLowerCase()} />
                <KeyValue
                  k="Tenure"
                  v={`${client.loanRequest.tenureMonths} months · ${client.loanRequest.repaymentFrequency.toLowerCase()}`}
                />
                <KeyValue
                  k="Est. installment"
                  v={
                    client.loanRequest.estimatedInstallment !== undefined ? (
                      <Money value={client.loanRequest.estimatedInstallment} />
                    ) : (
                      "—"
                    )
                  }
                />
              </div>
            )}

            {client.bankAccount && (
              <div className="border-2 border-ink bg-white p-3">
                <div className="mb-2 text-[10px] font-black uppercase tracking-[0.14em]">
                  Bank account
                </div>
                <KeyValue k="Account holder" v={client.bankAccount.accountHolderName} />
                <KeyValue
                  k="Bank / branch"
                  v={`${client.bankAccount.bankName} · ${client.bankAccount.branch}`}
                />
                <KeyValue
                  k="Account no. / IFSC"
                  v={`${client.bankAccount.accountNumber} · ${client.bankAccount.ifscCode}`}
                  mono
                />
              </div>
            )}

            {client.nominee && (
              <div className="border-2 border-ink bg-white p-3">
                <div className="mb-2 text-[10px] font-black uppercase tracking-[0.14em]">
                  Nominee
                </div>
                <KeyValue k="Name" v={client.nominee.name} />
                <KeyValue
                  k="Relationship / age"
                  v={`${client.nominee.relationship} · ${client.nominee.age} yrs`}
                />
                <KeyValue k="Mobile" v={client.nominee.mobile ?? "—"} mono />
                <KeyValue k="Address" v={client.nominee.address ?? "—"} />
              </div>
            )}

            <KeyValue
              k="Declaration accepted"
              v={
                client.declarationAcceptedAt
                  ? formatDateTime(client.declarationAcceptedAt)
                  : "—"
              }
            />

            {client.officeUse && (
              <div className="border-2 border-ink bg-gold p-3">
                <div className="mb-2 text-[10px] font-black uppercase tracking-[0.14em]">
                  For office use only
                </div>
                <KeyValue k="Field officer" v={client.officeUse.fieldOfficerName ?? "—"} />
                <KeyValue
                  k="Customer/group verification"
                  v={(client.officeUse.customerVerification ?? "not assessed").toLowerCase().replace("_", " ")}
                />
                <KeyValue
                  k="KYC verification"
                  v={(client.officeUse.kycVerification ?? "not assessed").toLowerCase()}
                />
                <KeyValue
                  k="Credit assessment"
                  v={(client.officeUse.creditAssessment ?? "not assessed").toLowerCase().replace("_", " ")}
                />
                <KeyValue
                  k="Approved amount"
                  v={
                    client.officeUse.approvedLoanAmount !== undefined ? (
                      <Money value={client.officeUse.approvedLoanAmount} />
                    ) : (
                      "—"
                    )
                  }
                />
                <KeyValue k="Remarks" v={client.officeUse.remarks ?? "—"} />
                <KeyValue k="Updated" v={formatDateTime(client.officeUse.updatedAt)} />
              </div>
            )}
          </section>

          {canVerify && (
            <section className="border-2 border-ink bg-gold p-4 shadow-hard-sm">
              <div className="flex items-center gap-2 text-xs font-black uppercase">
                <ShieldCheck className="size-4" /> KYC decision
              </div>
              <p className="mt-1 text-[11px] font-semibold">
                Current status: {client.kycStatus.toLowerCase()}. Verification is
                recorded in the audit trail with your name.
              </p>
              <div className="mt-3 flex gap-2">
                <Button
                  size="sm"
                  className="flex-1"
                  disabled={busy || client.kycStatus === "VERIFIED"}
                  onClick={() =>
                    void act(
                      () => verifyKyc({ clientId, status: "VERIFIED" }),
                      "KYC verified",
                    )
                  }
                >
                  <UserCheck /> Verify
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  className="flex-1"
                  disabled={busy || client.kycStatus === "REJECTED"}
                  onClick={() =>
                    void act(
                      () => verifyKyc({ clientId, status: "REJECTED", note: "Rejected at review" }),
                      "KYC rejected",
                    )
                  }
                >
                  Reject
                </Button>
              </div>
            </section>
          )}

          <section>
            <SectionTitle>Activity trail</SectionTitle>
            <div className="flex flex-col gap-2">
              {activity.length === 0 && (
                <EmptyState title="No activity yet" hint="Payments, documents and notes will appear here." />
              )}
              {activity.slice(0, 30).map((a, i) => (
                <div
                  key={i}
                  className="flex items-start justify-between gap-3 border-2 border-ink bg-card px-3 py-2 shadow-hard-sm"
                >
                  <div className="min-w-0">
                    <p className="text-xs font-bold">{a.text}</p>
                    {a.detail && (
                      <p className="truncate text-[11px] font-semibold text-muted-foreground">
                        {a.detail}
                      </p>
                    )}
                  </div>
                  <span className="shrink-0 text-[10px] font-black uppercase text-muted-foreground">
                    {timeAgo(a.at)}
                  </span>
                </div>
              ))}
            </div>
          </section>

          {recovery.length > 0 && (
            <section>
              <SectionTitle>Recovery activities</SectionTitle>
              <div className="flex flex-col gap-2">
                {recovery.map((r) => (
                  <div key={r._id} className="border-2 border-ink bg-blush px-3 py-2 shadow-hard-sm">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-black uppercase">
                        {RECOVERY_LABELS[r.kind as keyof typeof RECOVERY_LABELS] ?? r.kind}
                      </span>
                      <span className="text-[10px] font-black uppercase text-muted-foreground">
                        {formatDate(r.createdAt)}
                      </span>
                    </div>
                    {r.notes && <p className="text-[11px] font-semibold">{r.notes}</p>}
                  </div>
                ))}
              </div>
            </section>
          )}
        </TabsContent>

        {/* -------------------------------- LOANS ---------------------------- */}
        <TabsContent value="loans" className="mt-4 space-y-2">
          {loans.length === 0 ? (
            <EmptyState title="No loans yet" hint="Originate the first loan from the Collect or Loans screen." />
          ) : (
            loans.map(({ loan, rows }) => {
              const paid = rows.filter((r) => r.paid >= r.totalDue).length;
              return (
                <button
                  key={loan._id}
                  onClick={() => navigate(`/dashboard/loans/${loan._id}`)}
                  className="flex w-full items-center justify-between gap-3 border-2 border-ink bg-card p-3 text-left shadow-hard-sm active:translate-x-[2px] active:translate-y-[2px] active:shadow-none"
                >
                  <span className="min-w-0">
                    <span className="block font-mono text-sm font-black">{loan.loanId}</span>
                    <span className="block text-[11px] font-semibold text-muted-foreground">
                      {LOAN_STATUS_LABELS[loan.status] ?? loan.status} · {loan.frequency.toLowerCase()} ·{" "}
                      {loan.interestRate}% {loan.interestMethod.toLowerCase()}
                    </span>
                    <span className="mt-1 block text-[11px] font-bold">
                      {paid}/{rows.length} installments paid
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    <Money value={loan.principal} className="block text-base" />
                    <span className="text-[10px] font-black uppercase text-muted-foreground">
                      due {formatINR(loan.outstanding)}
                    </span>
                  </span>
                </button>
              );
            })
          )}
        </TabsContent>

        {/* ------------------------------ PAYMENTS --------------------------- */}
        <TabsContent value="payments" className="mt-4 space-y-2">
          {payments.length === 0 ? (
            <EmptyState title="No payments yet" icon={<IndianRupee className="size-5" />} />
          ) : (
            payments.map((p) => (
              <div
                key={p._id}
                className="flex items-center justify-between gap-3 border-2 border-ink bg-card px-3 py-2 shadow-hard-sm"
              >
                <div className="min-w-0">
                  <p className="text-sm font-black">
                    <Money value={p.amount} />
                    <span className="ml-2 text-[11px] font-black uppercase text-muted-foreground">
                      {p.mode}
                    </span>
                  </p>
                  <p className="text-[11px] font-semibold text-muted-foreground">
                    {p.receiptNumber ?? p.code} · {formatDateTime(p.createdAt)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <StatusChip status={p.status} />
                  {p.status === "NORMAL" && p.receiptNumber && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => navigate(`/dashboard/receipts/${p.receiptNumber}`)}
                    >
                      <FileText className="size-3.5" />
                    </Button>
                  )}
                </div>
              </div>
            ))
          )}
        </TabsContent>

        {/* ------------------------------ DOCUMENTS -------------------------- */}
        <TabsContent value="docs" className="mt-4 space-y-3">
          {can("edit_client") && (
            <section className="space-y-2 border-2 border-ink bg-card p-3 shadow-hard-sm">
              <div className="grid grid-cols-2 gap-2">
                <select
                  value={docType}
                  onChange={(e) => setDocType(e.target.value)}
                  className="h-11 border-2 border-ink bg-white px-2 text-sm font-bold outline-none"
                >
                  <option value="KYC">KYC</option>
                  <option value="ADDRESS_PROOF">Address proof</option>
                  <option value="CLIENT_PHOTO">Photo</option>
                  <option value="OTHER">Other</option>
                </select>
                <input
                  value={docName}
                  onChange={(e) => setDocName(e.target.value)}
                  placeholder="file-name.jpg"
                  className="h-11 border-2 border-ink bg-white px-2 text-sm font-semibold outline-none"
                />
              </div>
              <Button
                size="sm"
                className="w-full"
                disabled={!docName.trim() || busy}
                onClick={() =>
                  void act(async () => {
                    await addDocument({ clientId, type: docType, fileName: docName.trim() });
                    setDocName("");
                  }, "Document recorded")
                }
              >
                Record document
              </Button>
            </section>
          )}
          {ownDocs.length === 0 ? (
            <EmptyState
              title="No documents"
              hint={
                coApplicantDocs.length > 0
                  ? "No applicant documents yet — co-applicant files are shown in the Co-applicant card."
                  : "Record KYC and address proofs above."
              }
            />
          ) : (
            ownDocs.map((d) => (
              <div
                key={d._id}
                className="flex items-center justify-between gap-3 border-2 border-ink bg-card px-3 py-2 shadow-hard-sm"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-black">{d.fileName}</p>
                  <p className="text-[11px] font-semibold text-muted-foreground">
                    {d.type.replace(/_/g, " ")} · {formatDate(d.createdAt)}
                  </p>
                  {d.note && <p className="text-[11px] font-semibold">{d.note}</p>}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {d.url && (
                    <Button size="sm" variant="outline" asChild>
                      <a href={d.url} target="_blank" rel="noreferrer">
                        View
                      </a>
                    </Button>
                  )}
                  <StatusChip status={d.status} />
                  {canVerify && d.status !== "VERIFIED" && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void act(
                          () => decideDocument({ documentId: d._id, status: "VERIFIED" }),
                          "Document verified",
                        )
                      }
                    >
                      <UserCheck className="size-3.5" />
                    </Button>
                  )}
                </div>
              </div>
            ))
          )}
        </TabsContent>

        {/* -------------------------------- NOTES ---------------------------- */}
        <TabsContent value="notes" className="mt-4 space-y-3">
          <section className="space-y-2 border-2 border-ink bg-card p-3 shadow-hard-sm">
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Add a visit note, promise-to-pay, or observation…"
              className="min-h-20 w-full border-2 border-ink bg-white px-3 py-2 text-sm font-semibold outline-none"
            />
            <Button
              size="sm"
              className="w-full"
              disabled={!note.trim() || busy}
              onClick={() =>
                void act(async () => {
                  await addNote({ clientId, body: note.trim() });
                  setNote("");
                }, "Note added")
              }
            >
              <NotebookPen className="size-4" /> Save note
            </Button>
          </section>
          {notes.length === 0 ? (
            <EmptyState title="No notes yet" />
          ) : (
            notes.map((n) => (
              <div key={n._id} className="border-2 border-ink bg-card px-3 py-2 shadow-hard-sm">
                <p className="text-sm font-semibold">{n.body}</p>
                <p className="mt-1 text-[11px] font-black uppercase text-muted-foreground">
                  {n.author ?? "—"} · {timeAgo(n.createdAt)}
                </p>
              </div>
            ))
          )}
        </TabsContent>
      </Tabs>

      <div className="flex items-center justify-center gap-2 text-[11px] font-black uppercase text-muted-foreground">
        Client ID <CopyableCode value={client.code} />
      </div>
    </div>
  );
}
