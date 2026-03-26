import { useState, useMemo } from "react";
import {
  Search,
  FileText,
  Download,
  ExternalLink,
} from "lucide-react";

import { PageHeader } from "../../components/common/PageHeader";
import { QueryState } from "../../components/common/QueryState";
import { EmptyState } from "../../components/common/EmptyState";
import { StatusBadge } from "../../components/common/StatusBadge";
import { useApiQuery } from "../../lib/api";

/* ── Types ──────────────────────────────────────────────────────── */

type Invoice = {
  id: string;
  number?: string;
  amount: number;
  currency?: string;
  status: string;
  period_start?: string;
  period_end?: string;
  created_at?: string;
  due_date?: string;
  pdf_url?: string;
  hosted_url?: string;
  description?: string;
};

/* ── Invoices Page ──────────────────────────────────────────────── */

export function InvoicesPage() {
  const [search, setSearch] = useState("");

  const { data, loading, error, refetch } = useApiQuery<Invoice[]>(
    "/api/v1/billing/invoices",
  );

  const invoices = useMemo(() => data ?? [], [data]);

  const filtered = useMemo(() => {
    if (!search) return invoices;
    const q = search.toLowerCase();
    return invoices.filter(
      (inv) =>
        inv.id.toLowerCase().includes(q) ||
        inv.number?.toLowerCase().includes(q) ||
        inv.status.toLowerCase().includes(q) ||
        inv.description?.toLowerCase().includes(q),
    );
  }, [invoices, search]);

  const formatCurrency = (amount: number, currency = "usd") => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
    }).format(amount / 100); // assume amounts in cents
  };

  const formatDate = (dateStr?: string) => {
    if (!dateStr) return "--";
    return new Date(dateStr).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  };

  return (
    <div>
      <PageHeader
        title="Invoices"
        subtitle={`${invoices.length} invoices`}
        onRefresh={() => void refetch()}
      />

      {/* Search bar */}
      <div className="flex items-center gap-3 mb-4">
        <div className="relative flex-1 max-w-xs">
          <Search
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
          />
          <input
            type="text"
            placeholder="Search invoices..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 text-xs"
          />
        </div>
      </div>

      <QueryState
        loading={loading}
        error={error}
        isEmpty={invoices.length === 0}
        emptyMessage=""
        onRetry={() => void refetch()}
      >
        {filtered.length === 0 ? (
          <EmptyState
            icon={<FileText size={40} />}
            title="No invoices found"
            description={
              search
                ? "Try a different search term"
                : "No invoices to display yet"
            }
          />
        ) : (
          <div className="card p-0">
            <div className="overflow-x-auto">
              <table>
                <thead>
                  <tr>
                    <th>Invoice</th>
                    <th>Date</th>
                    <th>Period</th>
                    <th className="text-right">Amount</th>
                    <th>Status</th>
                    <th>Due Date</th>
                    <th style={{ width: "80px" }}></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((invoice) => (
                    <tr key={invoice.id}>
                      <td>
                        <div>
                          <span className="font-medium text-text-primary text-xs">
                            {invoice.number || invoice.id}
                          </span>
                          {invoice.description && (
                            <p className="text-[10px] text-text-muted mt-0.5 truncate max-w-[200px]">
                              {invoice.description}
                            </p>
                          )}
                        </div>
                      </td>
                      <td className="text-xs text-text-muted">
                        {formatDate(invoice.created_at)}
                      </td>
                      <td className="text-[10px] text-text-muted">
                        {invoice.period_start && invoice.period_end
                          ? `${formatDate(invoice.period_start)} - ${formatDate(invoice.period_end)}`
                          : "--"}
                      </td>
                      <td className="text-right font-mono text-xs text-text-primary">
                        {formatCurrency(invoice.amount, invoice.currency)}
                      </td>
                      <td>
                        <StatusBadge status={invoice.status} />
                      </td>
                      <td className="text-xs text-text-muted">
                        {formatDate(invoice.due_date)}
                      </td>
                      <td>
                        <div className="flex items-center gap-1">
                          {invoice.pdf_url && (
                            <a
                              href={invoice.pdf_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="p-1.5 rounded hover:bg-surface-overlay transition-colors"
                              title="Download PDF"
                            >
                              <Download size={12} className="text-text-muted" />
                            </a>
                          )}
                          {invoice.hosted_url && (
                            <a
                              href={invoice.hosted_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="p-1.5 rounded hover:bg-surface-overlay transition-colors"
                              title="View invoice"
                            >
                              <ExternalLink size={12} className="text-text-muted" />
                            </a>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </QueryState>
    </div>
  );
}

export { InvoicesPage as default };
