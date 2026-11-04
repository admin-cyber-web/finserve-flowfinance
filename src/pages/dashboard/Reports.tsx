import { api } from "@/convex/_generated/api";
import ClientStatement from "@/components/fs/ClientStatement";
import {
  EmptyState,
  PageHeader,
  RowSkeleton,
  formatDate,
} from "@/components/fs/primitives";
import { Button } from "@/components/ui/button";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { useProfile } from "@/hooks/use-profile";
import type { CommonReportRow } from "@/lib/finance/excelReports";
import {
  DATE_REPORT_PRESETS,
  DATE_REPORT_PRESET_LABELS,
  presetRange,
  type DateReportPreset,
} from "@/lib/finance/dateReport";
import { formatINR } from "@/lib/finance/money";
import { formatMeetingDateShort } from "@/lib/meeting";
import { cn, fmtId } from "@/lib/utils";
import { useQuery } from "convex/react";
import { Download, FileBarChart, Lock } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

/**
 * Reports — exactly four sheets, one institution-local date range:
 *
 *   1. Disbursement Report      loans disbursed between From and To
 *   2. Collection Report        successful payments between From and To
 *   3. Due Date Collection      loans with an installment due in the range
 *   4. Overdue Report           arrears as of the To date, bucketed
 *
 * Rows are produced server-side (`reports.rangeReports`) from the loan,
 * schedule and collection ledgers, scoped to the viewer's role and branch.
 * The CSV export mirrors the on-screen table of the selected report and
 * period. Nothing here is demo data — every figure is a stored record.
 */

const REPORTS = ["disbursement", "collection", "due", "overdue", "statement"] as const;
type ReportKey = (typeof REPORTS)[number];

const REPORT_LABELS: Record<ReportKey, string> = {
  disbursement: "Disbursement Report",
  collection: "Collection Report",
  due: "Due Date Collection",
  overdue: "Overdue Report",
  statement: "Statement",
};

/** The first ten columns — identical in all four reports (the Excel sheet). */
const COMMON_HEAD = [
  "Sr. No.",
  "Client ID",
  "Loan ID",
  "Group Name",
  "Group ID",
  "Customer Name",
  "Disbursement Date",
  "Loan Amount",
  "Tenure",
  "EMI",
];

const TAILS: Record<ReportKey, string[]> = {
  disbursement: [],
  collection: ["MOB", "Paid Date", "Paid Amount"],
  due: [
    "Meeting Day",
    "Next Due Date",
    "MOB",
    "Arrear",
    "Arrear Days",
    "Total Due Amount",
  ],
  overdue: ["BKT 1 (1–7 days)", "BKT 2 (8–15 days)", "BKT 3 (16–22 days)"],
  statement: [],
};

const INPUT_CLS =
  "h-11 w-full border-2 border-ink bg-white px-2 text-sm font-bold outline-none";
const TH_CLS =
  "border border-ink bg-muted px-1.5 py-1 text-left text-[10px] font-black uppercase whitespace-nowrap";
const TD_CLS = "border border-ink px-1.5 py-1 font-semibold";

function CommonCells({ row }: { row: CommonReportRow }) {
  return (
    <>
      <td className={cn(TD_CLS, "text-center font-black")}>{row.sr}</td>
      <td className={cn(TD_CLS, "font-mono whitespace-nowrap")}>
        {fmtId(row.clientCode)}
      </td>
      <td className={cn(TD_CLS, "font-mono whitespace-nowrap")}>{fmtId(row.loanId)}</td>
      <td className={TD_CLS}>{row.groupName}</td>
      <td className={cn(TD_CLS, "font-mono whitespace-nowrap")}>{fmtId(row.groupId)}</td>
      <td className={TD_CLS}>{row.customerName}</td>
      <td className={cn(TD_CLS, "whitespace-nowrap")}>
        {row.disbursedAt ? formatDate(row.disbursedAt) : "—"}
      </td>
      <td className={cn(TD_CLS, "text-right whitespace-nowrap")}>
        {formatINR(row.loanAmount)}
      </td>
      <td className={cn(TD_CLS, "text-center")}>{row.tenure}</td>
      <td className={cn(TD_CLS, "text-right whitespace-nowrap")}>
        {formatINR(row.emi)}
      </td>
    </>
  );
}

function ReportTable({
  report,
  children,
  totals,
}: {
  report: ReportKey;
  children: ReactNode;
  totals: ReactNode;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-2 border-ink text-xs">
        <thead>
          <tr>
            {[...COMMON_HEAD, ...TAILS[report]].map((h) => (
              <th key={h} className={TH_CLS}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
        <tfoot>{totals}</tfoot>
      </table>
    </div>
  );
}

/** Totals strip: seven label cells, then one cell per remaining column. */
function TotalsCells({
  rows,
  extra,
}: {
  rows: number;
  extra: ReactNode;
}) {
  return (
    <>
      <td
        colSpan={7}
        className={cn(
          TD_CLS,
          "bg-navy text-right text-[10px] font-black uppercase text-paper",
        )}
      >
        Totals — {rows} {rows === 1 ? "row" : "rows"}
      </td>
      <td className={cn(TD_CLS, "bg-navy text-right font-black text-paper")} />
      <td className={cn(TD_CLS, "bg-navy")} />
      <td className={cn(TD_CLS, "bg-navy")} />
      {extra}
    </>
  );
}

const cell = cn(TD_CLS, "bg-navy text-right font-black whitespace-nowrap text-paper");
const cellBlank = cn(TD_CLS, "bg-navy");

function sum<T>(rows: T[], pick: (r: T) => number): string {
  return formatINR(Math.round(rows.reduce((s, r) => s + pick(r), 0) * 100) / 100);
}

export default function Reports() {
  const { can } = useProfile();

  // Date-wise filtering — institution-local (IST) days, both ends included.
  const initial = presetRange("THIS_MONTH") ?? { fromIso: "", toIso: "" };
  const [from, setFrom] = useState(initial.fromIso);
  const [to, setTo] = useState(initial.toIso);
  const [active, setActive] = useState<ReportKey>("disbursement");

  const rangeError = useMemo(() => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return "Pick a valid From date and To date.";
    }
    if (from > to) return "From date must be on or before To date.";
    return null;
  }, [from, to]);

  const data = useQuery(
    api.reports.rangeReports,
    rangeError ? "skip" : { fromDay: from, toDay: to },
  );

  const activePreset: DateReportPreset | "CUSTOM" = useMemo(() => {
    for (const p of DATE_REPORT_PRESETS) {
      if (p === "CUSTOM") continue;
      const r = presetRange(p);
      if (r && r.fromIso === from && r.toIso === to) return p;
    }
    return "CUSTOM";
  }, [from, to]);

  const disbursement = data?.disbursement ?? [];
  const collection = data?.collection ?? [];
  const dueRows = data?.dueDateCollection ?? [];
  const overdue = data?.overdue ?? [];
  const rowCount =
    active === "disbursement"
      ? disbursement.length
      : active === "collection"
        ? collection.length
        : active === "due"
          ? dueRows.length
          : active === "overdue"
            ? overdue.length
            : 0;

  /* ------------------------------- CSV export ---------------------------- */

  const csvFor = (): string | null => {
    if (!data) return null;
    let head: string[] = [];
    let body: (string | number)[][] = [];
    switch (active) {
      case "disbursement":
        head = COMMON_HEAD;
        body = disbursement.map((r) => [
          r.sr,
          fmtId(r.clientCode),
          fmtId(r.loanId),
          r.groupName,
          fmtId(r.groupId),
          r.customerName,
          r.disbursedAt ? formatDate(r.disbursedAt) : "—",
          r.loanAmount,
          r.tenure,
          r.emi,
        ]);
        break;
      case "collection":
        head = [...COMMON_HEAD, ...TAILS.collection];
        body = collection.map((r) => [
          r.sr,
          fmtId(r.clientCode),
          fmtId(r.loanId),
          r.groupName,
          fmtId(r.groupId),
          r.customerName,
          r.disbursedAt ? formatDate(r.disbursedAt) : "—",
          r.loanAmount,
          r.tenure,
          r.emi,
          r.mob ?? "—",
          formatDate(r.paidAt),
          r.paidAmount,
        ]);
        break;
      case "due":
        head = [...COMMON_HEAD, ...TAILS.due];
        body = dueRows.map((r) => [
          r.sr,
          fmtId(r.clientCode),
          fmtId(r.loanId),
          r.groupName,
          fmtId(r.groupId),
          r.customerName,
          r.disbursedAt ? formatDate(r.disbursedAt) : "—",
          r.loanAmount,
          r.tenure,
          r.emi,
          r.centerMeetingDay,
          formatMeetingDateShort(r.nextDueDate),
          r.mob ?? "—",
          r.arrear,
          r.arrearDays,
          r.totalDueAmount,
        ]);
        break;
      case "overdue":
        head = [...COMMON_HEAD, ...TAILS.overdue];
        body = overdue.map((r) => [
          r.sr,
          fmtId(r.clientCode),
          fmtId(r.loanId),
          r.groupName,
          fmtId(r.groupId),
          r.customerName,
          r.disbursedAt ? formatDate(r.disbursedAt) : "—",
          r.loanAmount,
          r.tenure,
          r.emi,
          r.bkt1,
          r.bkt2,
          r.bkt3,
        ]);
        break;
    }
    const esc = (v: string | number) => {
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const meta: (string | number)[][] = [
      ["Organisation", "KIRAT MICRO CREDIT"],
      ["Report", REPORT_LABELS[active]],
      [
        "Period (institution-local dates, both ends included)",
        `${data.range.fromKey} → ${data.range.toKey}`,
      ],
      ["Rows", rowCount],
      ["Generated at", new Date().toISOString()],
    ];
    return [
      ...meta.map((m) => m.map(esc).join(",")),
      "",
      head.map(esc).join(","),
      ...body.map((r) => r.map(esc).join(",")),
    ].join("\n");
  };

  const download = () => {
    const csv = csvFor();
    if (!csv || !data) return;
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `kirat-${active}-report_${data.range.fromKey}_to_${data.range.toKey}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  /* --------------------------------- Screen ------------------------------ */

  if (!can("reports")) {
    return (
      <div className="space-y-4">
        <PageHeader title="Reports" subtitle="Disbursement · Collection · Due date · Overdue" />
        <EmptyState
          title="Not authorised"
          hint="Your role does not include the reports permission."
          icon={<Lock className="size-5" />}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Reports"
        subtitle="Disbursement · Collection · Due date · Overdue — one date range, four sheets · Statement"
      />

      {/* The shared From/To period and CSV export belong to the four
          date-range sheets; the Statement section brings its own search
          and period filter inside its tab. */}
      {active !== "statement" && (
        <>
      {/* Quick ranges — evaluated in the institution's local day (IST) */}
      <div className="flex flex-wrap gap-1.5">
        {DATE_REPORT_PRESETS.filter((p) => p !== "CUSTOM").map((p) => (
          <button
            key={p}
            onClick={() => {
              const r = presetRange(p);
              if (!r) return;
              setFrom(r.fromIso);
              setTo(r.toIso);
            }}
            className={cn(
              "border-2 border-ink px-2.5 py-1.5 text-[11px] font-black uppercase",
              activePreset === p
                ? "bg-navy text-paper shadow-hard-sm"
                : "bg-white",
            )}
          >
            {DATE_REPORT_PRESET_LABELS[p]}
          </button>
        ))}
      </div>

      {/* From / To — the date-wise filter every one of the four reports uses */}
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <label
            htmlFor="rep-from"
            className="text-[10px] font-black uppercase text-muted-foreground"
          >
            From date
          </label>
          <input
            id="rep-from"
            type="date"
            value={from}
            max={to}
            onChange={(e) => setFrom(e.target.value)}
            className={INPUT_CLS}
          />
        </div>
        <div className="space-y-1">
          <label
            htmlFor="rep-to"
            className="text-[10px] font-black uppercase text-muted-foreground"
          >
            To date
          </label>
          <input
            id="rep-to"
            type="date"
            value={to}
            min={from}
            onChange={(e) => setTo(e.target.value)}
            className={INPUT_CLS}
          />
        </div>
      </div>
      {rangeError && (
        <p className="text-[11px] font-black uppercase text-destructive">
          {rangeError}
        </p>
      )}

      {data && (
        <section className="border-2 border-ink bg-navy px-3 py-3 text-paper shadow-hard">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div className="min-w-0">
              <div className="text-[10px] font-black uppercase tracking-[0.18em] text-gold">
                Report period — institution-local dates, both ends included
              </div>
              <div className="font-mono text-sm font-black">
                {data.range.fromKey} → {data.range.toKey}
              </div>
            </div>
            <div className="text-right text-[11px] font-bold text-paper/80">
              <div>{REPORT_LABELS[active]}</div>
              <div>{rowCount} rows</div>
            </div>
          </div>
        </section>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          onClick={download}
          disabled={!data || rangeError !== null}
        >
          <Download className="size-4" /> Export CSV — {REPORT_LABELS[active]}
        </Button>
      </div>
        </>
      )}

      {/* ------------------------- The four reports ------------------------ */}
      <Tabs value={active} onValueChange={(v) => setActive(v as ReportKey)}>
        <TabsList className="h-auto w-full flex-wrap border-2 border-ink bg-white p-1">
          {REPORTS.map((r) => (
            <TabsTrigger
              key={r}
              value={r}
              className="flex-1 text-[11px] font-black uppercase"
            >
              {REPORT_LABELS[r]}
            </TabsTrigger>
          ))}
        </TabsList>

        {rangeError || data === undefined ? (
          <div className="mt-4">
            {rangeError ? (
              <EmptyState
                title="Fix the date range"
                hint={rangeError}
                icon={<FileBarChart className="size-5" />}
              />
            ) : (
              <RowSkeleton rows={8} />
            )}
          </div>
        ) : (
          <>
            {/* 1 — Disbursement Report */}
            <TabsContent value="disbursement" className="mt-4 space-y-3">
              {disbursement.length === 0 ? (
                <EmptyState
                  title="No disbursements in this period"
                  hint="Every loan disbursed between the From and To dates appears here. Try a wider range."
                  icon={<FileBarChart className="size-5" />}
                />
              ) : (
                <ReportTable
                  report="disbursement"
                  totals={
                    <tr>
                      <TotalsCells
                        rows={disbursement.length}
                        extra={
                          <>
                            <td className={cell}>
                              {sum(disbursement, (r) => r.loanAmount)}
                            </td>
                            <td className={cellBlank} />
                            <td className={cell}>
                              {sum(disbursement, (r) => r.emi)}
                            </td>
                          </>
                        }
                      />
                    </tr>
                  }
                >
                  {disbursement.map((r) => (
                    <tr key={r.loanId} className="hover:bg-sky/40">
                      <CommonCells row={r} />
                    </tr>
                  ))}
                </ReportTable>
              )}
            </TabsContent>

            {/* 2 — Collection Report */}
            <TabsContent value="collection" className="mt-4 space-y-3">
              <p className="border-2 border-ink bg-sky p-2 text-[11px] font-bold">
                Counted from the collection ledger's NORMAL payments only —
                reversed payments and their compensating entries are excluded,
                so no rupee is ever counted twice. MOB is completed months from
                disbursement to the paid date.
              </p>
              {collection.length === 0 ? (
                <EmptyState
                  title="No collections in this period"
                  hint="Every successful payment received between the From and To dates appears here."
                  icon={<FileBarChart className="size-5" />}
                />
              ) : (
                <ReportTable
                  report="collection"
                  totals={
                    <tr>
                      <TotalsCells
                        rows={collection.length}
                        extra={
                          <>
                            <td className={cellBlank} />
                            <td className={cellBlank} />
                            <td className={cell}>
                              {sum(collection, (r) => r.paidAmount)}
                            </td>
                          </>
                        }
                      />
                    </tr>
                  }
                >
                  {collection.map((r) => (
                    <tr key={`${r.loanId}-${r.paidAt}-${r.sr}`} className="hover:bg-sky/40">
                      <CommonCells row={r} />
                      <td className={cn(TD_CLS, "text-center")}>
                        {r.mob ?? "—"}
                      </td>
                      <td className={cn(TD_CLS, "whitespace-nowrap")}>
                        {formatDate(r.paidAt)}
                      </td>
                      <td className={cn(TD_CLS, "text-right whitespace-nowrap")}>
                        {formatINR(r.paidAmount)}
                      </td>
                    </tr>
                  ))}
                </ReportTable>
              )}
            </TabsContent>

            {/* 3 — Due Date Collection */}
            <TabsContent value="due" className="mt-4 space-y-3">
              <p className="border-2 border-ink bg-sky p-2 text-[11px] font-bold">
                One row per loan with an installment due between the From and
                To dates. Arrear is unpaid money overdue as of the To date,
                Arrear Days counts from its oldest unpaid due date, and Total
                Due is everything unpaid due on or before the To date (arrear ⊆
                total due — never double counted).
              </p>
              {dueRows.length === 0 ? (
                <EmptyState
                  title="No installments due in this period"
                  hint="Loans with an installment due between the From and To dates appear here."
                  icon={<FileBarChart className="size-5" />}
                />
              ) : (
                <ReportTable
                  report="due"
                  totals={
                    <tr>
                      <TotalsCells
                        rows={dueRows.length}
                        extra={
                          <>
                            <td className={cellBlank} />
                            <td className={cellBlank} />
                            <td className={cellBlank} />
                            <td className={cell}>
                              {sum(dueRows, (r) => r.arrear)}
                            </td>
                            <td className={cellBlank} />
                            <td className={cell}>
                              {sum(dueRows, (r) => r.totalDueAmount)}
                            </td>
                          </>
                        }
                      />
                    </tr>
                  }
                >
                  {dueRows.map((r) => (
                    <tr key={r.loanId} className="hover:bg-sky/40">
                      <CommonCells row={r} />
                      <td className={cn(TD_CLS, "whitespace-nowrap")}>
                        {r.centerMeetingDay}
                      </td>
                      <td className={cn(TD_CLS, "whitespace-nowrap")}>
                        {formatMeetingDateShort(r.nextDueDate)}
                      </td>
                      <td className={cn(TD_CLS, "text-center")}>
                        {r.mob ?? "—"}
                      </td>
                      <td
                        className={cn(
                          TD_CLS,
                          "text-right whitespace-nowrap",
                          r.arrear > 0 && "font-black text-destructive",
                        )}
                      >
                        {formatINR(r.arrear)}
                      </td>
                      <td className={cn(TD_CLS, "text-center")}>
                        {r.arrearDays || "—"}
                      </td>
                      <td className={cn(TD_CLS, "text-right whitespace-nowrap")}>
                        {formatINR(r.totalDueAmount)}
                      </td>
                    </tr>
                  ))}
                </ReportTable>
              )}
            </TabsContent>

            {/* 4 — Overdue Report */}
            <TabsContent value="overdue" className="mt-4 space-y-3">
              <p className="border-2 border-ink bg-sky p-2 text-[11px] font-bold">
                Overdue money as of the To date. Every rupee is counted in
                exactly one bucket (1–7 / 8–15 / 16–22 days past due); arrears
                older than 22 days are not spread across these buckets — they
                stay in Overdue &amp; Recovery with their own ageing.
              </p>
              {overdue.length === 0 ? (
                <EmptyState
                  title="Nothing overdue as of the To date"
                  hint="Loans with unpaid installments past their due date appear here."
                  icon={<FileBarChart className="size-5" />}
                />
              ) : (
                <ReportTable
                  report="overdue"
                  totals={
                    <tr>
                      <TotalsCells
                        rows={overdue.length}
                        extra={
                          <>
                            <td className={cell}>
                              {sum(overdue, (r) => r.bkt1)}
                            </td>
                            <td className={cell}>
                              {sum(overdue, (r) => r.bkt2)}
                            </td>
                            <td className={cell}>
                              {sum(overdue, (r) => r.bkt3)}
                            </td>
                          </>
                        }
                      />
                    </tr>
                  }
                >
                  {overdue.map((r) => {
                    const anyBucket = r.bkt1 + r.bkt2 + r.bkt3 > 0;
                    return (
                      <tr key={r.loanId} className="hover:bg-sky/40">
                        <CommonCells row={r} />
                        <td
                          className={cn(
                            TD_CLS,
                            "text-right whitespace-nowrap",
                            r.bkt1 > 0 && "font-black text-destructive",
                          )}
                        >
                          {anyBucket ? formatINR(r.bkt1) : "—"}
                        </td>
                        <td
                          className={cn(
                            TD_CLS,
                            "text-right whitespace-nowrap",
                            r.bkt2 > 0 && "font-black text-destructive",
                          )}
                        >
                          {anyBucket ? formatINR(r.bkt2) : "—"}
                        </td>
                        <td
                          className={cn(
                            TD_CLS,
                            "text-right whitespace-nowrap",
                            r.bkt3 > 0 && "font-black text-destructive",
                          )}
                        >
                          {anyBucket ? formatINR(r.bkt3) : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </ReportTable>
              )}
            </TabsContent>
          </>
        )}

        {/* 5 — Statement: its own search, period and ledger; independent of
            the shared date-range bar above. */}
        <TabsContent value="statement" className="mt-4">
          <ClientStatement />
        </TabsContent>
      </Tabs>
    </div>
  );
}
