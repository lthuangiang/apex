/** Số dư giả theo ngày (trang Fake-money test, Test results). Đường đứt = vốn ban đầu. Toạ độ vẽ dùng number. */
export function BalanceChart({
  points,
  capital,
  label,
  caption,
}: {
  points: readonly { date: string; equity: string }[];
  capital: string;
  label: string;
  caption: string;
}) {
  if (points.length < 2) return null;
  const ys = [...points.map((p) => Number(p.equity)), Number(capital)];
  const [y0, y1] = [Math.min(...ys), Math.max(...ys)];
  const W = 600;
  const H = 180;
  const sx = (i: number) => (i / (points.length - 1)) * W;
  const sy = (y: number) => H - ((y - y0) / (y1 - y0 || 1)) * (H - 12) - 6;
  const line = points
    .map((p, i) => `${sx(i).toFixed(1)},${sy(Number(p.equity)).toFixed(1)}`)
    .join(" ");
  const base = sy(Number(capital));
  return (
    <figure className="m-0 flex flex-col gap-1">
      <svg
        viewBox={`0 0 ${String(W)} ${String(H)}`}
        className="h-44 w-full text-accent"
        role="img"
        aria-label={label}
        preserveAspectRatio="none"
      >
        <line
          x1="0"
          x2={W}
          y1={base}
          y2={base}
          className="stroke-muted"
          strokeDasharray="4 4"
          strokeWidth="1"
        />
        <polyline points={line} fill="none" stroke="currentColor" strokeWidth="2" />
      </svg>
      <figcaption className="text-xs text-muted">{caption}</figcaption>
    </figure>
  );
}
