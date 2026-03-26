import { useMemo, useState } from "react";
import {
  Download,
  Shield,
  ShieldAlert,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { Link } from "react-router-dom";

import { PageHeader } from "../../components/common/PageHeader";
import { useToast } from "../../components/common/ToastProvider";

/* ── Types ──────────────────────────────────────────────────────── */

type SeverityKey = "critical" | "high" | "medium" | "low";

type FindingSummary = {
  total: number;
  bySeverity: Record<SeverityKey, number>;
  remediated: number;
  accepted: number;
  open: number;
};

type TrendPoint = {
  date: string;
  count: number;
};

type AffectedAgent = {
  name: string;
  findingCount: number;
  topSeverity: SeverityKey;
};

/* ── Mock data ──────────────────────────────────────────────────── */

const MOCK_SUMMARY: FindingSummary = {
  total: 8,
  bySeverity: { critical: 2, high: 3, medium: 2, low: 1 },
  remediated: 1,
  accepted: 1,
  open: 6,
};

const MOCK_AIVSS_SCORE = 7.4;

function generateTrend(): TrendPoint[] {
  const points: TrendPoint[] = [];
  const now = new Date("2026-03-26");
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const base = 4 + Math.sin(i * 0.3) * 2;
    points.push({
      date: d.toISOString().slice(0, 10),
      count: Math.max(0, Math.round(base + Math.random() * 3)),
    });
  }
  return points;
}

const MOCK_TREND = generateTrend();

const MOCK_TOP_AGENTS: AffectedAgent[] = [
  { name: "workflow-orchestrator", findingCount: 3, topSeverity: "critical" },
  { name: "customer-support-v2", findingCount: 2, topSeverity: "critical" },
  { name: "data-pipeline-agent", findingCount: 2, topSeverity: "high" },
  { name: "auth-gateway-agent", findingCount: 1, topSeverity: "low" },
];

/* ── Helpers ─────────────────────────────────────────────────────── */

const SEVERITY_COLORS: Record<SeverityKey, string> = {
  critical: "var(--color-status-error)",
  high: "var(--color-chart-orange)",
  medium: "var(--color-status-warning)",
  low: "var(--color-chart-blue)",
};

function aivssColor(score: number): string {
  if (score >= 7) return "var(--color-status-error)";
  if (score >= 3) return "var(--color-status-warning)";
  return "var(--color-status-live)";
}

function aivssLabel(score: number): string {
  if (score >= 9) return "Critical";
  if (score >= 7) return "High";
  if (score >= 4) return "Medium";
  if (score > 0) return "Low";
  return "None";
}

/* ── Donut Chart (inline SVG) ────────────────────────────────────── */

function DonutChart({
  data,
}: {
  data: Record<SeverityKey, number>;
}) {
  const entries = (Object.entries(data) as [SeverityKey, number][]).filter(
    ([, v]) => v > 0,
  );
  const total = entries.reduce((sum, [, v]) => sum + v, 0);
  if (total === 0) return null;

  const size = 140;
  const cx = size / 2;
  const cy = size / 2;
  const outerR = 60;
  const innerR = 40;

  let startAngle = -90;
  const arcs = entries.map(([severity, count]) => {
    const angle = (count / total) * 360;
    const endAngle = startAngle + angle;

    const startRad = (startAngle * Math.PI) / 180;
    const endRad = (endAngle * Math.PI) / 180;

    const x1 = cx + outerR * Math.cos(startRad);
    const y1 = cy + outerR * Math.sin(startRad);
    const x2 = cx + outerR * Math.cos(endRad);
    const y2 = cy + outerR * Math.sin(endRad);
    const x3 = cx + innerR * Math.cos(endRad);
    const y3 = cy + innerR * Math.sin(endRad);
    const x4 = cx + innerR * Math.cos(startRad);
    const y4 = cy + innerR * Math.sin(startRad);

    const largeArc = angle > 180 ? 1 : 0;

    const path = [
      `M ${x1} ${y1}`,
      `A ${outerR} ${outerR} 0 ${largeArc} 1 ${x2} ${y2}`,
      `L ${x3} ${y3}`,
      `A ${innerR} ${innerR} 0 ${largeArc} 0 ${x4} ${y4}`,
      "Z",
    ].join(" ");

    startAngle = endAngle;

    return { severity, path, count };
  });

  return (
    <div className="flex items-center gap-[var(--space-4)]">
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label="Findings by severity donut chart"
      >
        {arcs.map((arc) => (
          <path
            key={arc.severity}
            d={arc.path}
            fill={SEVERITY_COLORS[arc.severity]}
            opacity={0.85}
          />
        ))}
        <text
          x={cx}
          y={cy - 6}
          textAnchor="middle"
          fill="var(--color-text-primary)"
          fontSize="20"
          fontWeight="700"
          fontFamily="monospace"
        >
          {total}
        </text>
        <text
          x={cx}
          y={cy + 12}
          textAnchor="middle"
          fill="var(--color-text-muted)"
          fontSize="10"
          textTransform="uppercase"
        >
          findings
        </text>
      </svg>

      <div className="flex flex-col gap-[var(--space-2)]">
        {entries.map(([severity, count]) => (
          <div key={severity} className="flex items-center gap-[var(--space-2)]">
            <span
              className="w-2.5 h-2.5 rounded-full flex-shrink-0"
              style={{ backgroundColor: SEVERITY_COLORS[severity] }}
            />
            <span className="text-[var(--text-xs)] text-text-secondary capitalize w-16">
              {severity}
            </span>
            <span className="text-[var(--text-xs)] font-mono font-semibold text-text-primary">
              {count}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Line Chart (inline SVG) ─────────────────────────────────────── */

function TrendLineChart({ data }: { data: TrendPoint[] }) {
  if (data.length === 0) return null;

  const width = 500;
  const height = 120;
  const padX = 32;
  const padY = 16;

  const maxCount = Math.max(...data.map((d) => d.count), 1);
  const chartW = width - padX * 2;
  const chartH = height - padY * 2;

  const points = data.map((d, i) => ({
    x: padX + (i / (data.length - 1)) * chartW,
    y: padY + chartH - (d.count / maxCount) * chartH,
    ...d,
  }));

  const linePath = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`)
    .join(" ");

  const areaPath =
    linePath +
    ` L ${points[points.length - 1].x} ${padY + chartH} L ${points[0].x} ${padY + chartH} Z`;

  return (
    <svg
      width="100%"
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="Findings trend over last 30 days"
    >
      {/* Grid lines */}
      {[0, 0.25, 0.5, 0.75, 1].map((pct) => {
        const y = padY + chartH * (1 - pct);
        return (
          <g key={pct}>
            <line
              x1={padX}
              y1={y}
              x2={width - padX}
              y2={y}
              stroke="var(--color-border-subtle)"
              strokeWidth={0.5}
            />
            <text
              x={padX - 6}
              y={y + 3}
              textAnchor="end"
              fill="var(--color-text-muted)"
              fontSize="8"
              fontFamily="monospace"
            >
              {Math.round(maxCount * pct)}
            </text>
          </g>
        );
      })}

      {/* Area fill */}
      <path
        d={areaPath}
        fill="var(--color-accent-muted)"
        opacity={0.4}
      />

      {/* Line */}
      <path
        d={linePath}
        fill="none"
        stroke="var(--color-accent)"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {/* Data points */}
      {points.filter((_, i) => i % 5 === 0 || i === points.length - 1).map((p, i) => (
        <circle
          key={i}
          cx={p.x}
          cy={p.y}
          r={2.5}
          fill="var(--color-accent)"
          stroke="var(--color-surface-raised)"
          strokeWidth={1.5}
        />
      ))}

      {/* X-axis labels */}
      {points
        .filter((_, i) => i % 7 === 0 || i === points.length - 1)
        .map((p, i) => (
          <text
            key={i}
            x={p.x}
            y={height - 2}
            textAnchor="middle"
            fill="var(--color-text-muted)"
            fontSize="7"
            fontFamily="monospace"
          >
            {new Date(p.date).toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
            })}
          </text>
        ))}
    </svg>
  );
}

/* ── Progress Bar ────────────────────────────────────────────────── */

function RemediationProgress({
  resolved,
  total,
}: {
  resolved: number;
  total: number;
}) {
  const pct = total > 0 ? Math.round((resolved / total) * 100) : 0;

  return (
    <div>
      <div className="flex items-center justify-between mb-[var(--space-2)]">
        <span className="text-[var(--text-xs)] text-text-muted uppercase tracking-wide">
          Remediation Progress
        </span>
        <span className="text-[var(--text-sm)] font-mono font-semibold text-text-primary">
          {pct}%
        </span>
      </div>
      <div className="progress-track h-2">
        <div
          className="h-full rounded-full transition-all"
          style={{
            width: `${pct}%`,
            backgroundColor:
              pct >= 80
                ? "var(--color-status-live)"
                : pct >= 50
                  ? "var(--color-status-warning)"
                  : "var(--color-status-error)",
          }}
        />
      </div>
      <p className="text-[var(--text-2xs)] text-text-muted mt-[var(--space-1)]">
        {resolved} of {total} findings resolved
      </p>
    </div>
  );
}

/* ── Report Page Component ───────────────────────────────────────── */

export function ReportPage() {
  const { showToast } = useToast();
  const [summary] = useState<FindingSummary>(MOCK_SUMMARY);
  const [aivssScore] = useState(MOCK_AIVSS_SCORE);
  const [trend] = useState(MOCK_TREND);
  const [topAgents] = useState(MOCK_TOP_AGENTS);

  const resolvedCount = useMemo(
    () => summary.remediated + summary.accepted,
    [summary],
  );

  const trendDirection = useMemo(() => {
    if (trend.length < 2) return "flat";
    const recent = trend.slice(-7).reduce((s, p) => s + p.count, 0);
    const prior = trend.slice(-14, -7).reduce((s, p) => s + p.count, 0);
    return recent < prior ? "down" : recent > prior ? "up" : "flat";
  }, [trend]);

  const handleExport = () => {
    showToast("Report export started. You will be notified when ready.", "success");
  };

  return (
    <div className="max-w-[1400px] mx-auto">
      <PageHeader
        title="Vulnerability Report"
        subtitle="Security posture overview and findings analysis"
        icon={<ShieldAlert size={20} />}
        actions={
          <div className="flex items-center gap-[var(--space-2)]">
            <Link
              to="/security"
              className="btn btn-secondary text-[var(--text-xs)] min-h-[var(--touch-target-min)]"
            >
              <Shield size={14} />
              Back to Security
            </Link>
            <button
              onClick={handleExport}
              className="btn btn-primary text-[var(--text-xs)] min-h-[var(--touch-target-min)]"
            >
              <Download size={14} />
              Export Report
            </button>
          </div>
        }
      />

      {/* ── Summary Header ───────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-[var(--space-4)] mb-[var(--space-8)]">
        {/* Donut Chart */}
        <div className="card card-lift">
          <h3 className="text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-3)]">
            Findings by Severity
          </h3>
          <DonutChart data={summary.bySeverity} />
        </div>

        {/* AIVSS Score */}
        <div className="card card-lift">
          <h3 className="text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-3)]">
            AIVSS Risk Score
          </h3>
          <div className="flex items-center gap-[var(--space-4)]">
            <div
              className="flex items-center justify-center w-20 h-20 rounded-full border-4"
              style={{
                borderColor: aivssColor(aivssScore),
              }}
            >
              <span
                className="text-[var(--text-xl)] font-bold font-mono"
                style={{ color: aivssColor(aivssScore) }}
              >
                {aivssScore.toFixed(1)}
              </span>
            </div>
            <div>
              <p
                className="text-[var(--text-sm)] font-semibold uppercase"
                style={{ color: aivssColor(aivssScore) }}
              >
                {aivssLabel(aivssScore)}
              </p>
              <p className="text-[var(--text-2xs)] text-text-muted mt-[var(--space-1)]">
                Aggregate risk score across all agents
              </p>
            </div>
          </div>
        </div>

        {/* Remediation Progress */}
        <div className="card card-lift">
          <h3 className="text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-3)]">
            Resolution Status
          </h3>
          <RemediationProgress resolved={resolvedCount} total={summary.total} />

          <div className="flex gap-[var(--space-4)] mt-[var(--space-4)]">
            <div className="text-center">
              <p className="text-[var(--text-lg)] font-bold font-mono text-status-error">
                {summary.open}
              </p>
              <p className="text-[var(--text-2xs)] text-text-muted uppercase">Open</p>
            </div>
            <div className="text-center">
              <p className="text-[var(--text-lg)] font-bold font-mono text-status-live">
                {summary.remediated}
              </p>
              <p className="text-[var(--text-2xs)] text-text-muted uppercase">Fixed</p>
            </div>
            <div className="text-center">
              <p className="text-[var(--text-lg)] font-bold font-mono text-status-warning">
                {summary.accepted}
              </p>
              <p className="text-[var(--text-2xs)] text-text-muted uppercase">Accepted</p>
            </div>
          </div>
        </div>
      </div>

      {/* ── Trend Chart ──────────────────────────────────────────── */}
      <section className="mb-[var(--space-8)]">
        <div className="card">
          <div className="flex items-center justify-between mb-[var(--space-3)]">
            <h3 className="text-[var(--text-xs)] text-text-muted uppercase tracking-wide">
              Findings Trend (Last 30 Days)
            </h3>
            <div className="flex items-center gap-[var(--space-1)]">
              {trendDirection === "down" ? (
                <TrendingDown size={14} className="text-status-live" />
              ) : trendDirection === "up" ? (
                <TrendingUp size={14} className="text-status-error" />
              ) : null}
              <span
                className={`text-[var(--text-xs)] font-semibold ${
                  trendDirection === "down"
                    ? "text-status-live"
                    : trendDirection === "up"
                      ? "text-status-error"
                      : "text-text-muted"
                }`}
              >
                {trendDirection === "down"
                  ? "Improving"
                  : trendDirection === "up"
                    ? "Worsening"
                    : "Stable"}
              </span>
            </div>
          </div>
          <TrendLineChart data={trend} />
        </div>
      </section>

      {/* ── Top Affected Agents ──────────────────────────────────── */}
      <section className="mb-[var(--space-8)]">
        <h3 className="text-[var(--text-xs)] text-text-muted uppercase tracking-wide mb-[var(--space-3)]">
          Top Affected Agents
        </h3>
        <div className="card">
          <div className="space-y-[var(--space-3)]">
            {topAgents.map((agent) => {
              const pct = summary.total > 0 ? (agent.findingCount / summary.total) * 100 : 0;
              return (
                <div key={agent.name} className="flex items-center gap-[var(--space-3)]">
                  <span className="text-[var(--text-xs)] text-text-primary font-mono font-medium w-44 truncate">
                    {agent.name}
                  </span>
                  <div className="flex-1 progress-track h-2">
                    <div
                      className="h-full rounded-full transition-all"
                      style={{
                        width: `${pct}%`,
                        backgroundColor: SEVERITY_COLORS[agent.topSeverity],
                      }}
                    />
                  </div>
                  <span
                    className="text-[var(--text-xs)] font-mono font-semibold w-6 text-right"
                    style={{ color: SEVERITY_COLORS[agent.topSeverity] }}
                  >
                    {agent.findingCount}
                  </span>
                  <span
                    className="inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase border"
                    style={{
                      color: SEVERITY_COLORS[agent.topSeverity],
                      borderColor: SEVERITY_COLORS[agent.topSeverity],
                      backgroundColor: "transparent",
                    }}
                  >
                    {agent.topSeverity}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </section>
    </div>
  );
}

export { ReportPage as default };
