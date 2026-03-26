import { useState, useMemo } from "react";
import {
  Receipt,
  Download,
  Calendar,
  DollarSign,
  TrendingUp,
  Search,
} from "lucide-react";

import { PageHeader } from "../../components/common/PageHeader";
import { StatusBadge } from "../../components/common/StatusBadge";

/* ── Types ──────────────────────────────────────────────────────── */

type InvoiceStatus = "paid" | "pending" | "failed";

interface Invoice {
  id: string;
  number: string;
  date: string;
  amount: number;
  status: InvoiceStatus;
  pdfUrl: string;
  description: string;
}

/* ── Mock data ──────────────────────────────────────────────────── */

const MOCK_INVOICES: Invoice[] = [
  { id: "inv_001", number: "INV-2026-0312", date: "2026-03-01", amount: 49.0, status: "paid", pdfUrl: "#", description: "Pro Plan - March 2026" },
  { id: "inv_002", number: "INV-2026-0211", date: "2026-02-01", amount: 49.0, status: "paid", pdfUrl: "#", description: "Pro Plan - February 2026" },
  { id: "inv_003", number: "INV-2026-0110", date: "2026-01-01", amount: 49.0, status: "paid", pdfUrl: "#", description: "Pro Plan - January 2026" },
  { id: "inv_004", number: "INV-2025-1209", date: "2025-12-01", amount: 49.0, status: "paid", pdfUrl: "#", description: "Pro Plan - December 2025" },
  { id: "inv_005", number: "INV-2025-1108", date: "2025-11-01", amount: 49.0, status: "paid", pdfUrl: "#", description: "Pro Plan - November 2025" },
  { id: "inv_006", number: "INV-2025-1007", date: "2025-10-01", amount: 29.0, status: "paid", pdfUrl: "#", description: "Starter Plan - October 2025" },
  { id: "inv_007", number: "INV-2025-0906", date: "2025-09-01", amount: 29.0, status: "failed", pdfUrl: "#", description: "Starter Plan - September 2025" },
  { id: "inv_008", number: "INV-2025-0805", date: "2025-08-01", amount: 29.0, status: "paid", pdfUrl: "#", description: "Starter Plan - August 2025" },
];

/* ── Helpers ─────────────────────────────────────────────────────── */

function formatCurrency(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/* ── Component ──────────────────────────────────────────────────── */

export function InvoicesPage() {
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [searchQuery, setSearchQuery] = useState("");

  const filtered = useMemo(() => {
    let list = MOCK_INVOICES;

    if (dateFrom) {
      list = list.filter((inv) => inv.date >= dateFrom);
    }
    if (dateTo) {
      list = list.filter((inv) => inv.date <= dateTo);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(
        (inv) =>
          inv.number.toLowerCase().includes(q) ||
          inv.description.toLowerCase().includes(q),
      );
    }

    return list;
  }, [dateFrom, dateTo, searchQuery]);

  const totalSpent = useMemo(
    () => filtered.filter((i) => i.status === "paid").reduce((sum, i) => sum + i.amount, 0),
    [filtered],
  );

  const averageMonthly = useMemo(() => {
    const paidInvoices = filtered.filter((i) => i.status === "paid");
    if (paidInvoices.length === 0) return 0;
    return paidInvoices.reduce((sum, i) => sum + i.amount, 0) / paidInvoices.length;
  }, [filtered]);

  const pendingCount = useMemo(
    () => filtered.filter((i) => i.status === "pending").length,
    [filtered],
  );

  return (
    <div className="max-w-[1400px] mx-auto">
      <PageHeader
        title="Invoices"
        subtitle="View and download your billing history"
        icon={<Receipt size={20} />}
      />

      {/* Summary stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-[var(--space-3)] mb-[var(--space-6)]">
        <div className="card flex items-center gap-[var(--space-3)] py-[var(--space-3)]">
          <div className="p-2 rounded-lg bg-chart-green/10">
            <DollarSign size={16} className="text-chart-green" />
          </div>
          <div>
            <p className="text-[var(--text-xl)] font-bold text-text-primary font-mono">
              {formatCurrency(totalSpent)}
            </p>
            <p className="text-[10px] text-text-muted uppercase tracking-wide">
              Total Spent
            </p>
          </div>
        </div>

        <div className="card flex items-center gap-[var(--space-3)] py-[var(--space-3)]">
          <div className="p-2 rounded-lg bg-chart-blue/10">
            <TrendingUp size={16} className="text-chart-blue" />
          </div>
          <div>
            <p className="text-[var(--text-xl)] font-bold text-text-primary font-mono">
              {formatCurrency(averageMonthly)}
            </p>
            <p className="text-[10px] text-text-muted uppercase tracking-wide">
              Avg Monthly
            </p>
          </div>
        </div>

        <div className="card flex items-center gap-[var(--space-3)] py-[var(--space-3)]">
          <div className="p-2 rounded-lg bg-status-warning/10">
            <Receipt size={16} className="text-status-warning" />
          </div>
          <div>
            <p className="text-[var(--text-xl)] font-bold text-text-primary font-mono">
              {pendingCount}
            </p>
            <p className="text-[10px] text-text-muted uppercase tracking-wide">
              Pending
            </p>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-[var(--space-3)] mb-[var(--space-6)]">
        <div className="flex-1 min-w-[200px]">
          <label className="block text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
            Search
          </label>
          <div className="relative">
            <Search
              size={14}
              className="absolute left-[var(--space-3)] top-1/2 -translate-y-1/2 text-text-muted pointer-events-none"
            />
            <input
              type="text"
              placeholder="Search invoices..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 bg-surface-overlay min-h-[var(--touch-target-min)]"
            />
          </div>
        </div>

        <div>
          <label className="block text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
            <Calendar size={10} className="inline mr-1" />
            From
          </label>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="bg-surface-overlay min-h-[var(--touch-target-min)] w-[160px]"
          />
        </div>

        <div>
          <label className="block text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-1)]">
            <Calendar size={10} className="inline mr-1" />
            To
          </label>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="bg-surface-overlay min-h-[var(--touch-target-min)] w-[160px]"
          />
        </div>
      </div>

      {/* Invoice table */}
      <div className="card overflow-hidden p-0">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th>Date</th>
                <th>Invoice #</th>
                <th>Description</th>
                <th className="text-right">Amount</th>
                <th className="text-center">Status</th>
                <th className="text-center">PDF</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length > 0 ? (
                filtered.map((invoice) => (
                  <tr key={invoice.id}>
                    <td className="text-[var(--text-sm)] text-text-secondary whitespace-nowrap">
                      {formatDate(invoice.date)}
                    </td>
                    <td className="text-[var(--text-sm)] text-text-primary font-mono font-medium">
                      {invoice.number}
                    </td>
                    <td className="text-[var(--text-sm)] text-text-secondary">
                      {invoice.description}
                    </td>
                    <td className="text-[var(--text-sm)] text-text-primary font-mono font-semibold text-right">
                      {formatCurrency(invoice.amount)}
                    </td>
                    <td className="text-center">
                      <StatusBadge status={invoice.status} size="sm" />
                    </td>
                    <td className="text-center">
                      <a
                        href={invoice.pdfUrl}
                        className="inline-flex items-center justify-center w-[var(--touch-target-min)] h-[var(--touch-target-min)] rounded-md text-text-muted hover:text-accent hover:bg-accent-muted transition-colors"
                        title={`Download ${invoice.number}`}
                        aria-label={`Download PDF for invoice ${invoice.number}`}
                      >
                        <Download size={14} />
                      </a>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={6} className="text-center py-12 text-text-muted text-sm">
                    No invoices found for the selected filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export { InvoicesPage as default };
