import {
  EmptyState,
  KeyValue,
  PageHeader,
  RowSkeleton,
  StatusChip,
} from "@/components/fs/primitives";
import { api } from "@/convex/_generated/api";
import { useQuery } from "convex/react";
import { Package } from "lucide-react";

export default function Products() {
  const products = useQuery(api.loans.products, { activeOnly: false });

  return (
    <div className="space-y-4 pb-10">
      <PageHeader
        title="Loan products"
        subtitle="Terms drive schedule generation and eligibility policy"
      />

      {products === undefined ? (
        <RowSkeleton rows={4} />
      ) : products.length === 0 ? (
        <EmptyState
          title="No products configured"
          hint="Loan products define interest, tenure and policy limits."
          icon={<Package className="size-5" />}
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {products.map((p) => (
            <section key={p._id} className="border-2 border-ink bg-card shadow-hard">
              <div className="flex items-center justify-between gap-2 border-b-2 border-ink bg-navy px-3 py-2 text-paper">
                <div className="min-w-0">
                  <div className="truncate text-sm font-black uppercase">{p.name}</div>
                  <div className="font-mono text-[10px] font-bold uppercase text-gold">
                    {p.code}
                  </div>
                </div>
                <StatusChip status={p.status} />
              </div>
              <div className="p-3">
                <KeyValue
                  k="Interest"
                  v={`${p.interestRate}% ${p.interestMethod.toLowerCase()}`}
                />
                <KeyValue k="Tenure" v={`${p.tenure} ${p.frequency.toLowerCase()} periods`} />
                <KeyValue
                  k="Amount range"
                  v={`₹${p.minAmount.toLocaleString("en-IN")} – ₹${p.maxAmount.toLocaleString("en-IN")}`}
                  mono
                />
                <KeyValue
                  k="Charges"
                  v={`₹${p.processingFee.toLocaleString("en-IN")} + ${p.chargePercent}%`}
                />
                <KeyValue k="Grace days" v={String(p.graceDays)} />
                <KeyValue k="Max obligation" v={`${p.maxObligationRatio}% of income`} />
              </div>
            </section>
          ))}
        </div>
      )}

      <div className="border-2 border-ink bg-sky p-3 text-xs font-bold">
        Policy fields (max obligation ratio, ranges, overdue history) are
        evaluated on the server at submission <em>and</em> again at approval —
        they can never be bypassed from the UI.
      </div>
    </div>
  );
}
