// System Architecture Diagram (team): vị trí icon, đường nối và các luồng (request, WebSocket, bot, job…). Dữ liệu lấy
// từ docker-compose.yml (mạng, cổng, replica, volume) và code (outbox relay ở apps/jobs, subscribe ở apps/realtime, vòng
// tick của apps/engine, leader tracker của apps/marketdata). Câu chữ nằm trong en.json (`architecture.*`), không ở đây.

export type Tone = "net" | "app" | "ml" | "db" | "int" | "sec" | "ext";
export type IconName =
  | "user"
  | "spark"
  | "route"
  | "window"
  | "api"
  | "bolt"
  | "plug"
  | "cpu"
  | "chart"
  | "clock"
  | "queue"
  | "rewind"
  | "db"
  | "pool"
  | "stack"
  | "stream"
  | "key"
  | "lock"
  | "swap"
  | "eye"
  | "send";

export const NODE_IDS = [
  "users",
  "claude",
  "traefik",
  "web",
  "api",
  "realtime",
  "mcp",
  "engine",
  "marketdata",
  "jobs",
  "backtest",
  "reco",
  "pgbouncer",
  "postgres",
  "redis",
  "nats",
  "scheduler",
  "signer",
  "vault",
  "claudeApi",
  "sodex",
  "hyperliquid",
  "telegram",
] as const;
export type NodeId = (typeof NODE_IDS)[number];

export interface MapNode {
  x: number;
  y: number;
  icon: IconName;
  tone: Tone;
}

/** Tâm icon; ô icon 48×48 nằm ở (x − 24, y − 34), tên dưới y + 30. */
export const NODES: Record<NodeId, MapNode> = {
  users: { x: 80, y: 190, icon: "user", tone: "ext" },
  claude: { x: 80, y: 410, icon: "spark", tone: "ext" },
  traefik: { x: 270, y: 165, icon: "route", tone: "net" },
  web: { x: 420, y: 165, icon: "window", tone: "app" },
  api: { x: 560, y: 165, icon: "api", tone: "app" },
  realtime: { x: 700, y: 165, icon: "bolt", tone: "app" },
  mcp: { x: 840, y: 165, icon: "plug", tone: "app" },
  engine: { x: 270, y: 340, icon: "cpu", tone: "app" },
  marketdata: { x: 420, y: 340, icon: "chart", tone: "app" },
  jobs: { x: 560, y: 340, icon: "queue", tone: "app" },
  backtest: { x: 700, y: 340, icon: "rewind", tone: "app" },
  reco: { x: 840, y: 340, icon: "spark", tone: "ml" },
  pgbouncer: { x: 270, y: 480, icon: "pool", tone: "db" },
  postgres: { x: 420, y: 480, icon: "db", tone: "db" },
  redis: { x: 560, y: 480, icon: "stack", tone: "db" },
  nats: { x: 700, y: 480, icon: "stream", tone: "int" },
  scheduler: { x: 840, y: 480, icon: "clock", tone: "app" },
  signer: { x: 330, y: 700, icon: "key", tone: "sec" },
  vault: { x: 500, y: 700, icon: "lock", tone: "sec" },
  claudeApi: { x: 1037, y: 150, icon: "spark", tone: "ext" },
  sodex: { x: 1037, y: 400, icon: "swap", tone: "ext" },
  hyperliquid: { x: 1037, y: 590, icon: "eye", tone: "ext" },
  telegram: { x: 1037, y: 700, icon: "send", tone: "ext" },
};

export interface MapGroup {
  key: "internet" | "host" | "edge" | "core" | "secure" | "outside";
  x: number;
  y: number;
  w: number;
  h: number;
}

export const GROUPS: readonly MapGroup[] = [
  { key: "internet", x: 20, y: 30, w: 140, h: 730 },
  { key: "host", x: 170, y: 30, w: 765, h: 730 },
  { key: "edge", x: 190, y: 60, w: 725, h: 168 },
  { key: "core", x: 190, y: 250, w: 725, h: 350 },
  { key: "secure", x: 190, y: 620, w: 725, h: 130 },
  { key: "outside", x: 950, y: 30, w: 175, h: 730 },
];

type Pt = readonly [number, number];

/** Đường nối vuông góc đi qua các khe giữa hàng / cột, để không cắt ngang icon khác trong cùng một luồng. */
export const EDGES = {
  usersTraefik: {
    from: "users",
    to: "traefik",
    pts: [
      [108, 180],
      [200, 180],
      [200, 155],
      [242, 155],
    ],
  },
  claudeTraefik: {
    from: "claude",
    to: "traefik",
    pts: [
      [108, 400],
      [210, 400],
      [210, 163],
      [242, 163],
    ],
  },
  traefikWeb: {
    from: "traefik",
    to: "web",
    pts: [
      [298, 155],
      [392, 155],
    ],
  },
  traefikApi: {
    from: "traefik",
    to: "api",
    pts: [
      [264, 129],
      [264, 120],
      [560, 120],
      [560, 129],
    ],
  },
  traefikRt: {
    from: "traefik",
    to: "realtime",
    pts: [
      [276, 129],
      [276, 112],
      [700, 112],
      [700, 129],
    ],
  },
  traefikMcp: {
    from: "traefik",
    to: "mcp",
    pts: [
      [270, 217],
      [270, 238],
      [840, 238],
      [840, 217],
    ],
  },
  apiPg: {
    from: "api",
    to: "pgbouncer",
    pts: [
      [553, 217],
      [553, 290],
      [345, 290],
      [345, 425],
      [230, 425],
      [230, 470],
      [242, 470],
    ],
  },
  apiRedis: {
    from: "api",
    to: "redis",
    pts: [
      [567, 217],
      [567, 282],
      [630, 282],
      [630, 425],
      [566, 425],
      [566, 444],
    ],
  },
  pgPostgres: {
    from: "pgbouncer",
    to: "postgres",
    pts: [
      [298, 476],
      [392, 476],
    ],
  },
  rtNats: {
    from: "realtime",
    to: "nats",
    pts: [
      [694, 217],
      [694, 232],
      [762, 232],
      [762, 478],
      [728, 478],
    ],
  },
  natsRt: {
    from: "nats",
    to: "realtime",
    pts: [
      [728, 462],
      [784, 462],
      [784, 224],
      [706, 224],
      [706, 217],
    ],
  },
  engPg: {
    from: "engine",
    to: "pgbouncer",
    pts: [
      [270, 392],
      [270, 444],
    ],
  },
  jobsPg: {
    from: "jobs",
    to: "pgbouncer",
    pts: [
      [548, 392],
      [548, 436],
      [320, 436],
      [320, 462],
      [298, 462],
    ],
  },
  jobsNats: {
    from: "jobs",
    to: "nats",
    pts: [
      [574, 392],
      [574, 428],
      [690, 428],
      [690, 444],
    ],
  },
  engRedis: {
    from: "engine",
    to: "redis",
    pts: [
      [298, 352],
      [332, 352],
      [332, 404],
      [556, 404],
      [556, 444],
    ],
  },
  sodexMd: {
    from: "sodex",
    to: "marketdata",
    pts: [
      [1009, 376],
      [965, 376],
      [965, 266],
      [420, 266],
      [420, 306],
    ],
  },
  mdNats: {
    from: "marketdata",
    to: "nats",
    pts: [
      [430, 392],
      [430, 416],
      [700, 416],
      [700, 444],
    ],
  },
  natsEng: {
    from: "nats",
    to: "engine",
    pts: [
      [712, 444],
      [712, 430],
      [310, 430],
      [310, 362],
      [298, 362],
    ],
  },
  engSigner: {
    from: "engine",
    to: "signer",
    pts: [
      [242, 330],
      [205, 330],
      [205, 690],
      [302, 690],
    ],
  },
  signerVault: {
    from: "signer",
    to: "vault",
    pts: [
      [358, 690],
      [472, 690],
    ],
  },
  engSodex: {
    from: "engine",
    to: "sodex",
    pts: [
      [270, 306],
      [270, 296],
      [985, 296],
      [985, 390],
      [1009, 390],
    ],
  },
  natsBt: {
    from: "nats",
    to: "backtest",
    pts: [
      [700, 444],
      [700, 392],
    ],
  },
  btPg: {
    from: "backtest",
    to: "pgbouncer",
    pts: [
      [676, 352],
      [640, 352],
      [640, 412],
      [264, 412],
      [264, 444],
    ],
  },
  jobsSodex: {
    from: "jobs",
    to: "sodex",
    pts: [
      [560, 306],
      [560, 298],
      [985, 298],
      [985, 390],
      [1009, 390],
    ],
  },
  mcpRedis: {
    from: "mcp",
    to: "redis",
    pts: [
      [846, 217],
      [846, 246],
      [898, 246],
      [898, 432],
      [572, 432],
      [572, 444],
    ],
  },
  mcpApi: {
    from: "mcp",
    to: "api",
    pts: [
      [834, 129],
      [834, 104],
      [572, 104],
      [572, 129],
    ],
  },
  apiClaude: {
    from: "api",
    to: "claudeApi",
    pts: [
      [548, 129],
      [548, 96],
      [980, 96],
      [980, 140],
      [1009, 140],
    ],
  },
  hlMd: {
    from: "hyperliquid",
    to: "marketdata",
    pts: [
      [1009, 580],
      [955, 580],
      [955, 270],
      [426, 270],
      [426, 306],
    ],
  },
  mdPostgres: {
    from: "marketdata",
    to: "postgres",
    pts: [
      [420, 392],
      [420, 444],
    ],
  },
  jobsTelegram: {
    from: "jobs",
    to: "telegram",
    pts: [
      [566, 306],
      [566, 258],
      [940, 258],
      [940, 690],
      [1009, 690],
    ],
  },
} as const satisfies Record<string, { from: NodeId; to: NodeId; pts: readonly Pt[] }>;
export type EdgeId = keyof typeof EDGES;

/** Một bước: theo một đường nối (`rev` = chiều ngược lại) hoặc gắn vào một icon. Câu chữ: `architecture.flows.<flow>.steps.<i>`. */
export type Step = { edge: EdgeId; rev?: true } | { node: NodeId };

export const FLOW_IDS = [
  "page",
  "api",
  "live",
  "start",
  "pause",
  "auto",
  "copy",
  "watch",
  "job",
  "backtest",
  "mcp",
  "deskAi",
] as const;
export type FlowId = (typeof FLOW_IDS)[number];

/** Luồng mở mặc định: bot tự giao dịch, phần người mới hay hỏi nhất. */
export const DEFAULT_FLOW: FlowId = "auto";

const e = (edge: EdgeId): Step => ({ edge });
const back = (edge: EdgeId): Step => ({ edge, rev: true });
const n = (node: NodeId): Step => ({ node });

export const FLOWS: Record<FlowId, readonly Step[]> = {
  page: [e("usersTraefik"), e("traefikWeb"), n("web"), n("users")],
  api: [e("usersTraefik"), e("traefikApi"), e("apiRedis"), e("apiPg"), e("pgPostgres"), n("api")],
  live: [
    e("usersTraefik"),
    e("traefikRt"),
    e("rtNats"),
    e("engPg"),
    e("jobsPg"),
    e("jobsNats"),
    e("natsRt"),
    n("users"),
  ],
  start: [
    e("usersTraefik"),
    e("traefikApi"),
    e("apiPg"),
    e("engRedis"),
    e("engPg"),
    n("engine"),
    n("users"),
  ],
  pause: [
    e("usersTraefik"),
    e("traefikApi"),
    e("apiPg"),
    e("engPg"),
    n("engine"),
    e("jobsPg"),
    e("jobsNats"),
    e("natsRt"),
    n("users"),
    n("engine"),
    n("engine"),
  ],
  auto: [
    e("engRedis"),
    e("engPg"),
    e("sodexMd"),
    e("mdNats"),
    e("natsEng"),
    n("engine"),
    e("engSigner"),
    e("signerVault"),
    e("engSodex"),
    back("engSodex"),
    e("engPg"),
    n("engine"),
  ],
  copy: [
    e("usersTraefik"),
    e("traefikApi"),
    e("apiPg"),
    n("marketdata"),
    e("hlMd"),
    n("marketdata"),
    e("mdNats"),
    e("natsEng"),
    e("engSigner"),
    e("signerVault"),
    e("engSodex"),
    e("engPg"),
  ],
  watch: [
    e("usersTraefik"),
    e("traefikApi"),
    e("apiPg"),
    back("hlMd"),
    n("marketdata"),
    e("mdPostgres"),
    e("jobsPg"),
    e("jobsNats"),
    back("jobsNats"),
    e("jobsTelegram"),
  ],
  job: [
    e("usersTraefik"),
    e("traefikApi"),
    e("apiPg"),
    e("jobsPg"),
    e("jobsNats"),
    back("jobsNats"),
    e("jobsSodex"),
    back("jobsPg"),
    e("jobsTelegram"),
    n("realtime"),
  ],
  backtest: [
    e("usersTraefik"),
    e("traefikApi"),
    e("apiPg"),
    e("jobsPg"),
    e("jobsNats"),
    e("natsBt"),
    e("btPg"),
    n("realtime"),
  ],
  mcp: [e("claudeTraefik"), e("traefikMcp"), e("mcpRedis"), e("mcpApi"), e("apiPg"), n("mcp")],
  deskAi: [e("usersTraefik"), e("traefikApi"), e("apiPg"), e("apiClaude"), n("users")],
};

/** Các icon tham gia một luồng (còn lại vẽ mờ). */
export function nodesOf(flow: FlowId): ReadonlySet<NodeId> {
  const out = new Set<NodeId>();
  for (const s of FLOWS[flow]) {
    if ("node" in s) out.add(s.node);
    else {
      out.add(EDGES[s.edge].from);
      out.add(EDGES[s.edge].to);
    }
  }
  return out;
}

/** Số bước gắn trên mỗi đường nối, và đường nào có mũi tên ngược (bước `rev`). */
export function edgesOf(flow: FlowId): { edge: EdgeId; steps: number[]; back: boolean }[] {
  const map = new Map<EdgeId, { steps: number[]; back: boolean }>();
  FLOWS[flow].forEach((s, i) => {
    if (!("edge" in s)) return;
    const cur = map.get(s.edge) ?? { steps: [], back: false };
    cur.steps.push(i + 1);
    if (s.rev === true) cur.back = true;
    map.set(s.edge, cur);
  });
  return [...map].map(([edge, v]) => ({ edge, ...v }));
}

/** Điểm nằm ở tỉ lệ `t` (0–1) dọc theo đường gấp khúc. */
export function pointAt(pts: readonly Pt[], t: number): Pt {
  const segs = pts.slice(1).map((p, i) => {
    const a = pts[i] ?? p;
    return { a, b: p, len: Math.hypot(p[0] - a[0], p[1] - a[1]) };
  });
  let left = segs.reduce((s, x) => s + x.len, 0) * t;
  for (const s of segs) {
    if (left <= s.len) {
      const r = s.len === 0 ? 0 : left / s.len;
      return [s.a[0] + (s.b[0] - s.a[0]) * r, s.a[1] + (s.b[1] - s.a[1]) * r];
    }
    left -= s.len;
  }
  return pts.at(-1) ?? [0, 0];
}

/** Vị trí số bước trên một đường: một số ở giữa; nhiều số rải từ 30% tới 70%. */
export function badgeSpots(count: number): number[] {
  if (count <= 1) return [0.5];
  return Array.from({ length: count }, (_, i) => 0.3 + (0.4 * i) / (count - 1));
}
