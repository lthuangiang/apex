// Vạch trục Y "đẹp" (UI_REVIEW J1): bước là 1 · 2 · 2.5 · 5 × 10^n, vạch là bội số của bước, bao trọn [min, max].
// `decimals` là số chữ số thập phân chung cho mọi vạch (theo bước), để nhãn trục cùng định dạng.

export interface NiceTicks {
  ticks: number[];
  decimals: number;
}

export function niceTicks(min: number, max: number, target = 4): NiceTicks {
  let lo = Math.min(min, max);
  let hi = Math.max(min, max);
  if (hi === lo) {
    const d = Math.abs(lo) * 0.01 || 1;
    lo -= d;
    hi += d;
  }
  const raw = (hi - lo) / Math.max(1, target - 1);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * mag >= raw) ?? 10) * mag;
  const start = Math.floor(lo / step + 1e-9) * step;
  const end = Math.ceil(hi / step - 1e-9) * step;
  const decimals = Math.max(0, -Math.floor(Math.log10(step) + 1e-9) + (step / mag === 2.5 ? 1 : 0));
  const ticks: number[] = [];
  for (let v = start; v <= end + step / 2; v += step) ticks.push(Number(v.toFixed(decimals)));
  return { ticks, decimals };
}
