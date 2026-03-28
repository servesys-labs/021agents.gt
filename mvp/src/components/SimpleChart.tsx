interface DataPoint {
  label: string;
  value: number;
}

interface SimpleChartProps {
  data: DataPoint[];
  height?: number;
  color?: string;
  type?: "bar" | "line";
}

export function SimpleChart({ data, height = 160, color = "var(--color-primary)", type = "bar" }: SimpleChartProps) {
  if (data.length === 0) return null;

  const maxVal = Math.max(...data.map((d) => d.value), 1);
  const padding = { top: 10, bottom: 28, left: 8, right: 8 };
  const chartW = 100; // percent-based
  const chartH = height - padding.top - padding.bottom;

  if (type === "line") {
    const points = data.map((d, i) => {
      const x = padding.left + ((chartW - padding.left - padding.right) * i) / (data.length - 1 || 1);
      const y = padding.top + chartH - (d.value / maxVal) * chartH;
      return { x, y, ...d };
    });
    const pathD = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");

    return (
      <svg viewBox={`0 0 ${chartW} ${height}`} className="w-full animate-fade-in" preserveAspectRatio="none" style={{ height }}>
        <path d={pathD} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        {points.map((p, i) => (
          <g key={i}>
            <circle cx={p.x} cy={p.y} r="2" fill={color} />
            <text x={p.x} y={height - 6} textAnchor="middle" className="text-[3px] fill-text-muted">
              {p.label}
            </text>
          </g>
        ))}
      </svg>
    );
  }

  // Bar chart
  const barGap = 1;
  const totalBars = data.length;
  const barW = (chartW - padding.left - padding.right - barGap * (totalBars - 1)) / totalBars;

  return (
    <svg viewBox={`0 0 ${chartW} ${height}`} className="w-full animate-fade-in" preserveAspectRatio="none" style={{ height }}>
      {data.map((d, i) => {
        const barH = (d.value / maxVal) * chartH;
        const x = padding.left + i * (barW + barGap);
        const y = padding.top + chartH - barH;
        return (
          <g key={i}>
            <rect x={x} y={y} width={barW} height={barH} rx="1" fill={color} opacity={0.85} />
            <text x={x + barW / 2} y={height - 6} textAnchor="middle" className="text-[3px] fill-text-muted">
              {d.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
