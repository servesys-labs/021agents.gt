/**
 * Sparkline — inline SVG mini chart for activity trends.
 * No external dependencies. Renders a polyline + subtle area fill.
 *
 * @param data  - Array of 1-7 numeric data points
 * @param width - SVG width in px (default 80)
 * @param height - SVG height in px (default 24)
 */

interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
  className?: string;
}

export function Sparkline({ data, width = 80, height = 24, className }: SparklineProps) {
  if (!data.length) return null;

  const padding = 2;
  const innerW = width - padding * 2;
  const innerH = height - padding * 2;

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;

  const points = data.map((v, i) => {
    const x = padding + (i / Math.max(data.length - 1, 1)) * innerW;
    const y = padding + innerH - ((v - min) / range) * innerH;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const polyline = points.join(" ");

  // Area fill: close the path along the bottom
  const firstX = padding;
  const lastX = padding + innerW;
  const bottomY = height;
  const areaPath = `M ${points[0]} ${points.slice(1).map((p) => `L ${p}`).join(" ")} L ${lastX},${bottomY} L ${firstX},${bottomY} Z`;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      aria-hidden="true"
      style={{ display: "inline-block", verticalAlign: "middle" }}
    >
      {/* Area fill */}
      <path
        d={areaPath}
        fill="var(--color-accent)"
        fillOpacity={0.12}
      />
      {/* Line */}
      <polyline
        points={polyline}
        fill="none"
        stroke="var(--color-accent)"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
