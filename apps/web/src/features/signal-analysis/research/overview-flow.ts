// Hình học và kịch bản của sơ đồ "một vòng chạy" ở drawer How it works › Overview (#391, mockup
// docs/mockups/signal-research/how-it-works-overview.html). Thuần, không đọc API, không đọc DOM: component chỉ vẽ theo đây.
// Toạ độ theo viewBox 680 × 860 của mockup.

export const VIEW_W = 680;
export const VIEW_H = 860;

export type StepKey = "collect" | "normalize" | "score" | "context" | "filter" | "decide";
export const STEP_KEYS: readonly StepKey[] = [
  "collect",
  "normalize",
  "score",
  "context",
  "filter",
  "decide",
];
/** Mục mở / đóng bên dưới sơ đồ: 6 bước, rồi "Watcher and results". */
export type ListKey = StepKey | "watch";
export const LIST_KEYS: readonly ListKey[] = [...STEP_KEYS, "watch"];

export type StageKey = StepKey | "watcher" | "results";
export type EdgeKey = "src" | "ask" | "ans" | "ctx" | "bot" | "px" | "pxw" | "res";
export type DropKey = "noCoin" | "notCatalyst" | "highOnly";
export type NodeKey = "reader" | "watcher" | "results";

export interface Point {
  x: number;
  y: number;
}

export interface Stage {
  key: StageKey;
  /** Bước trên trục giữa được tô (null = Watcher / Results). */
  step: StepKey | null;
  /** Hộp phụ được tô (Claude reader, Watcher, Results). */
  node: NodeKey | null;
  /** Đường chấm chạy, từ điểm đầu tới điểm cuối. */
  path: readonly Point[];
  edges: readonly EdgeKey[];
  drop: { key: DropKey; y: number } | null;
  /** Mục của danh sách mở / đóng tương ứng. */
  list: ListKey;
}

const p = (x: number, y: number): Point => ({ x, y });

export const STAGES: readonly Stage[] = [
  {
    key: "collect",
    step: "collect",
    node: null,
    path: [p(79, 56), p(300, 56)],
    edges: ["src"],
    drop: null,
    list: "collect",
  },
  {
    key: "normalize",
    step: "normalize",
    node: null,
    path: [p(300, 56), p(300, 148)],
    edges: [],
    drop: { key: "noCoin", y: 152 },
    list: "normalize",
  },
  {
    key: "score",
    step: "score",
    node: "reader",
    path: [p(300, 148), p(300, 240), p(588, 240), p(300, 240)],
    edges: ["ask", "ans"],
    drop: { key: "notCatalyst", y: 244 },
    list: "score",
  },
  {
    key: "context",
    step: "context",
    node: null,
    path: [p(300, 240), p(300, 332)],
    edges: ["ctx"],
    drop: null,
    list: "context",
  },
  {
    key: "filter",
    step: "filter",
    node: null,
    path: [p(300, 332), p(300, 424)],
    edges: ["bot"],
    drop: { key: "highOnly", y: 428 },
    list: "filter",
  },
  {
    key: "decide",
    step: "decide",
    node: null,
    path: [p(300, 424), p(300, 516)],
    edges: ["px"],
    drop: null,
    list: "decide",
  },
  {
    key: "watcher",
    step: null,
    node: "watcher",
    path: [p(300, 516), p(300, 626)],
    edges: ["pxw"],
    drop: null,
    list: "watch",
  },
  {
    key: "results",
    step: null,
    node: "results",
    path: [p(300, 626), p(300, 736), p(420, 736)],
    edges: ["res"],
    drop: null,
    list: "watch",
  },
];

/** Khung của 6 bước trên trục giữa (để vẽ hộp và đặt nút bấm đè lên). */
export const STEP_BOX: Readonly<Record<StepKey, { x: number; y: number; w: number; h: number }>> = {
  collect: { x: 180, y: 20, w: 240, h: 72 },
  normalize: { x: 180, y: 112, w: 240, h: 72 },
  score: { x: 180, y: 204, w: 240, h: 72 },
  context: { x: 180, y: 296, w: 240, h: 72 },
  filter: { x: 180, y: 388, w: 240, h: 72 },
  decide: { x: 180, y: 480, w: 240, h: 72 },
};

/** Thời gian chấm chạy một chặng và thời gian đứng lại đọc caption (mockup: 1500 ms và 4200 ms). */
export const MOVE_MS = 1500;
export const HOLD_MS = 4200;

/** Chặng sau / trước, vòng lại ở hai đầu. */
export const wrapStage = (i: number): number =>
  ((i % STAGES.length) + STAGES.length) % STAGES.length;

/** Chặng đầu tiên của một bước (bấm bước trên sơ đồ). */
export const stageOfStep = (step: StepKey): number => STAGES.findIndex((s) => s.step === step);

/** Ease in-out bậc hai như mockup. */
export function ease(f: number): number {
  const x = Math.min(1, Math.max(0, f));
  return x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2;
}

/** Điểm ở phân số `f` (0..1) theo chiều dài của đường gấp khúc. */
export function pointAt(path: readonly Point[], f: number): Point {
  const first = path[0];
  if (first === undefined) return p(0, 0);
  const segs: number[] = [];
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1] ?? first;
    const b = path[i] ?? a;
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    segs.push(d);
    total += d;
  }
  if (total === 0) return first;
  let left = Math.min(1, Math.max(0, f)) * total;
  for (let i = 0; i < segs.length; i++) {
    const d = segs[i] ?? 0;
    const a = path[i] ?? first;
    const b = path[i + 1] ?? a;
    if (left <= d || i === segs.length - 1) {
      const r = d === 0 ? 1 : Math.min(1, left / d);
      return p(a.x + (b.x - a.x) * r, a.y + (b.y - a.y) * r);
    }
    left -= d;
  }
  return path[path.length - 1] ?? first;
}

/** Điểm cuối của chặng (reduced motion: chấm nhảy thẳng tới đây). */
export const endOf = (path: readonly Point[]): Point => pointAt(path, 1);
