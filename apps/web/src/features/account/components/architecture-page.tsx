"use client";

import { UserRole } from "@drift/shared";
import { useTranslations } from "next-intl";
import { useEffect, useId, useState, type KeyboardEvent, type ReactNode } from "react";

import { Card, PageHead, Workspace } from "@/components/workspace";
import { useMe } from "@/lib/queries";

import {
  badgeSpots,
  DEFAULT_FLOW,
  EDGES,
  edgesOf,
  FLOW_IDS,
  FLOWS,
  GROUPS,
  NODE_IDS,
  NODES,
  nodesOf,
  pointAt,
  type FlowId,
  type IconName,
  type MapGroup,
  type NodeId,
  type Tone,
} from "../architecture-map";

// System Architecture Diagram (team, dưới Market hours): container của docker-compose theo mạng Docker, kiểu sơ đồ
// tham chiếu AWS (icon theo nhóm màu, số bước). Chọn một luồng thì đường đi và các bước sáng lên; bấm icon để xem cổng,
// replica, mạng, volume. Trang tĩnh: không gọi API; chỉ hiện với role team (useMe), như các trang team khác.

const TONE: Record<Tone, string> = {
  net: "var(--arch-net)",
  app: "var(--arch-app)",
  ml: "var(--arch-ml)",
  db: "var(--arch-db)",
  int: "var(--arch-int)",
  sec: "var(--arch-sec)",
  ext: "var(--arch-ext)",
};

const GROUP_STYLE: Record<MapGroup["key"], { stroke: string; fill: string; dashed: boolean }> = {
  internet: { stroke: "var(--arch-ext)", fill: "var(--arch-ext-bg)", dashed: false },
  host: { stroke: "var(--arch-host)", fill: "transparent", dashed: true },
  edge: { stroke: "var(--arch-edge)", fill: "var(--arch-edge-bg)", dashed: false },
  core: { stroke: "var(--arch-core)", fill: "var(--arch-core-bg)", dashed: false },
  secure: { stroke: "var(--arch-secure)", fill: "var(--arch-secure-bg)", dashed: true },
  outside: { stroke: "var(--arch-ext)", fill: "var(--arch-ext-bg)", dashed: false },
};

/** Thứ tự hiện trong bảng chi tiết của một icon. */
const FACT_KEYS = [
  "image",
  "app",
  "ports",
  "replicas",
  "networks",
  "volumes",
  "role",
  "entry",
] as const;

function Icon({ name }: { name: IconName }) {
  switch (name) {
    case "user":
      return (
        <>
          <circle cx="12" cy="8" r="4" />
          <path d="M4 21c0-4 3.6-6 8-6s8 2 8 6" />
        </>
      );
    case "spark":
      return <path d="M12 3l2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2z" />;
    case "route":
      return <path d="M3 12h18M15 6l6 6-6 6M9 6L3 12l6 6" />;
    case "window":
      return (
        <>
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="M3 9h18" />
        </>
      );
    case "api":
      return (
        <path d="M8 4C5 4 5 6 5 8s-2 4-2 4 2 2 2 4 0 4 3 4M16 4c3 0 3 2 3 4s2 4 2 4-2 2-2 4 0 4-3 4" />
      );
    case "bolt":
      return <path d="M13 2L4 14h7l-1 8 9-12h-7z" />;
    case "plug":
      return <path d="M9 2v5M15 2v5M6 7h12v4a6 6 0 01-12 0zM12 17v5" />;
    case "cpu":
      return (
        <>
          <rect x="6" y="6" width="12" height="12" rx="1.5" />
          <path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" />
        </>
      );
    case "chart":
      return <path d="M3 20h18M5 16l4-5 4 3 6-8" />;
    case "clock":
      return (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </>
      );
    case "queue":
      return <path d="M4 6h16M4 12h16M4 18h10" />;
    case "rewind":
      return <path d="M11 6L4 12l7 6zM20 6l-7 6 7 6z" />;
    case "db":
      return (
        <>
          <ellipse cx="12" cy="6" rx="7" ry="3" />
          <path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3" />
        </>
      );
    case "pool":
      return (
        <>
          <rect x="8" y="8" width="8" height="8" rx="1" />
          <path d="M2 10h6M2 14h6M16 10h6M16 14h6" />
        </>
      );
    case "stack":
      return <path d="M3 8l9-4 9 4-9 4zM3 12l9 4 9-4M3 16l9 4 9-4" />;
    case "stream":
      return <path d="M3 7h13l-3-3M21 17H8l3 3M3 12h18" />;
    case "key":
      return (
        <>
          <circle cx="8" cy="15" r="4" />
          <path d="M11 12l9-9M16 7l3 3" />
        </>
      );
    case "lock":
      return (
        <>
          <rect x="5" y="11" width="14" height="10" rx="2" />
          <path d="M8 11V7a4 4 0 018 0v4" />
        </>
      );
    case "swap":
      return <path d="M4 8h15l-4-4M20 16H5l4 4" />;
    case "eye":
      return (
        <>
          <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" />
          <circle cx="12" cy="12" r="3" />
        </>
      );
    case "send":
      return <path d="M22 3L2 11l7 3 3 7 10-18zM9 14L22 3" />;
  }
}

const isFlow = (v: string): v is FlowId => (FLOW_IDS as readonly string[]).includes(v);

export function ArchitecturePage() {
  const t = useTranslations("architecture");
  const me = useMe();
  const notTeam = me.data !== undefined && me.data.role !== UserRole.team;
  const [flow, setFlow] = useState<FlowId>(DEFAULT_FLOW);
  const [node, setNode] = useState<NodeId | null>(null);
  const [hot, setHot] = useState<number | null>(null);
  const uid = useId();
  const arrow = `${uid}-arrow`;

  // Luồng nằm trong hash (#auto, #copy…) để gửi link cho nhau.
  useEffect(() => {
    const read = () => {
      const h = window.location.hash.slice(1);
      if (isFlow(h)) setFlow(h);
    };
    read();
    window.addEventListener("hashchange", read);
    return () => {
      window.removeEventListener("hashchange", read);
    };
  }, []);
  const pick = (f: FlowId) => {
    setFlow(f);
    setHot(null);
    window.history.replaceState(null, "", `#${f}`);
  };

  const steps = FLOWS[flow];
  const used = nodesOf(flow);
  const edges = edgesOf(flow);
  const hotStep = hot === null ? undefined : steps[hot - 1];
  const hotEdge = hotStep !== undefined && "edge" in hotStep ? hotStep.edge : null;
  const code = (chunks: ReactNode) => (
    <code className="rounded bg-surface-2 px-1 font-mono text-[0.92em]">{chunks}</code>
  );
  const onNodeKey = (e: KeyboardEvent, id: NodeId) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setNode(id);
    }
  };
  const facts =
    node === null ? null : (t.raw(`nodes.${node}.facts`) as Partial<Record<string, string>>);

  return (
    <Workspace current="architecture">
      <div className="flex flex-col gap-4">
        <PageHead title={t("title")} subtitle={t("subtitle")} />
        {notTeam ? (
          <Card>
            <p className="m-0">{t("forbidden")}</p>
          </Card>
        ) : (
          <>
            <nav aria-label={t("flowsLabel")} className="flex flex-wrap gap-2">
              {FLOW_IDS.map((f) => (
                <button
                  key={f}
                  type="button"
                  aria-pressed={flow === f}
                  onClick={() => {
                    pick(f);
                  }}
                  className={`inline-flex min-h-10 items-center gap-2 rounded-control border px-3.5 text-sm font-bold ${
                    flow === f
                      ? "border-ink bg-ink text-surface"
                      : "border-border bg-surface text-ink"
                  }`}
                >
                  <span className="font-mono text-[11px] opacity-75">{t(`flows.${f}.kind`)}</span>
                  {t(`flows.${f}.title`)}
                </button>
              ))}
            </nav>

            <div className="grid grid-cols-1 items-start gap-4 min-[1600px]:grid-cols-[minmax(0,1fr)_360px]">
              <div className="flex min-w-0 flex-col gap-2 rounded-card border border-border bg-surface p-2">
                <div
                  role="region"
                  aria-label={t("diagramLabel")}
                  // Sơ đồ rộng cuộn ngang trong khung riêng (390 px), trang không cuộn ngang.
                  // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
                  tabIndex={0}
                  className="overflow-x-auto"
                >
                  <svg
                    viewBox="0 0 1140 780"
                    role="group"
                    aria-label={t("diagramLabel")}
                    className="block h-auto w-full min-w-[900px]"
                  >
                    <defs>
                      <marker
                        id={arrow}
                        viewBox="0 0 10 10"
                        refX="8"
                        refY="5"
                        markerWidth="5"
                        markerHeight="5"
                        orient="auto-start-reverse"
                      >
                        <path d="M1 1L9 5L1 9z" style={{ fill: "var(--arch-flow)" }} />
                      </marker>
                    </defs>
                    {GROUPS.map((g) => {
                      const s = GROUP_STYLE[g.key];
                      return (
                        <g key={g.key}>
                          <rect
                            x={g.x}
                            y={g.y}
                            width={g.w}
                            height={g.h}
                            rx={6}
                            style={{ fill: s.fill, stroke: s.stroke }}
                            strokeWidth={1.2}
                            strokeDasharray={s.dashed ? "6 4" : undefined}
                          />
                          <rect
                            x={g.x}
                            y={g.y}
                            width={22}
                            height={22}
                            rx={3}
                            style={{ fill: s.stroke }}
                          />
                          <text
                            x={g.x + 30}
                            y={g.y + 15}
                            className="text-[13px] font-bold"
                            style={{ fill: s.stroke }}
                          >
                            {t(`groups.${g.key}`)}
                          </text>
                        </g>
                      );
                    })}
                    <rect
                      x={600}
                      y={552}
                      width={300}
                      height={32}
                      rx={5}
                      fill="none"
                      className="stroke-border"
                      strokeDasharray="4 3"
                    />
                    <text x={750} y={572} textAnchor="middle" className="fill-muted text-[12px]">
                      {t("notes.observability")}
                    </text>
                    <text x={620} y={694} className="fill-muted text-[12px]">
                      {t("notes.secure1")}
                    </text>
                    <text x={620} y={710} className="fill-muted text-[12px]">
                      {t("notes.secure2")}
                    </text>

                    {edges.map((x) => (
                      <path
                        key={x.edge}
                        d={`M${EDGES[x.edge].pts.map((p) => p.join(" ")).join(" L")}`}
                        fill="none"
                        className="arch-flow"
                        style={{ stroke: "var(--arch-flow)" }}
                        strokeWidth={hotEdge === x.edge ? 4 : 2.2}
                        strokeLinejoin="round"
                        strokeLinecap="round"
                        markerEnd={`url(#${arrow})`}
                        markerStart={x.back ? `url(#${arrow})` : undefined}
                      />
                    ))}

                    {NODE_IDS.map((id) => {
                      const n = NODES[id];
                      const selected = node === id;
                      return (
                        <g
                          key={id}
                          role="button"
                          tabIndex={0}
                          aria-label={t(`nodes.${id}.label`)}
                          aria-pressed={selected}
                          onClick={() => {
                            setNode(id);
                          }}
                          onKeyDown={(e) => {
                            onNodeKey(e, id);
                          }}
                          className={`cursor-pointer transition-opacity ${used.has(id) ? "" : "opacity-30"}`}
                        >
                          <rect
                            x={n.x - 24}
                            y={n.y - 34}
                            width={48}
                            height={48}
                            rx={6}
                            style={{ fill: TONE[n.tone] }}
                          />
                          {selected ? (
                            <rect
                              x={n.x - 28}
                              y={n.y - 38}
                              width={56}
                              height={56}
                              rx={8}
                              fill="none"
                              className="stroke-ink"
                              strokeWidth={2}
                            />
                          ) : null}
                          <g
                            transform={`translate(${String(n.x - 13)} ${String(n.y - 23)}) scale(1.08)`}
                            fill="none"
                            className="stroke-surface"
                            strokeWidth={1.8}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <Icon name={n.icon} />
                          </g>
                          <text
                            x={n.x}
                            y={n.y + 30}
                            textAnchor="middle"
                            className="fill-ink text-[13px] font-semibold"
                          >
                            {t(`nodes.${id}.label`)}
                          </text>
                          <text
                            x={n.x}
                            y={n.y + 45}
                            textAnchor="middle"
                            className="fill-muted font-mono text-[11px]"
                          >
                            {t(`nodes.${id}.sub`)}
                          </text>
                        </g>
                      );
                    })}

                    {edges.flatMap((x) =>
                      badgeSpots(x.steps.length).map((spot, k) => {
                        const [bx, by] = pointAt(EDGES[x.edge].pts, spot);
                        const num = x.steps[k] ?? 0;
                        return <Badge key={`${x.edge}-${String(num)}`} x={bx} y={by} n={num} />;
                      }),
                    )}
                    {steps.map((s, i) => {
                      if (!("node" in s)) return null;
                      const n = NODES[s.node];
                      // Nhiều bước cùng gắn một icon (Pause: engine 3 lần) xếp hàng ngang trên góc phải.
                      const before = steps
                        .slice(0, i)
                        .filter((x) => "node" in x && x.node === s.node).length;
                      return (
                        <Badge
                          key={`n-${String(i)}`}
                          x={n.x + 30 + before * 24}
                          y={n.y - 36}
                          n={i + 1}
                        />
                      );
                    })}
                  </svg>
                </div>
                <ul
                  aria-label={t("legendLabel")}
                  className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 px-2 pb-1 text-[13px] text-muted"
                >
                  {(Object.keys(TONE) as Tone[]).map((k) => (
                    <li key={k} className="flex items-center gap-1.5">
                      <span
                        aria-hidden="true"
                        className="inline-block size-3 rounded-[3px]"
                        style={{ background: TONE[k] }}
                      />
                      {t(`legend.${k}`)}
                    </li>
                  ))}
                </ul>
              </div>

              <aside
                aria-labelledby={`${uid}-flow`}
                className="flex min-w-0 flex-col gap-3 rounded-card border border-border bg-surface p-4"
              >
                <h2 id={`${uid}-flow`} className="m-0 text-lg font-extrabold">
                  {t(`flows.${flow}.title`)}
                </h2>
                <p className="m-0 text-sm text-ink-2">{t(`flows.${flow}.lead`)}</p>
                <ol
                  aria-label={t("stepsLabel")}
                  className="m-0 flex list-none flex-col gap-0.5 p-0"
                >
                  {steps.map((_, i) => {
                    const k = `flows.${flow}.steps.${String(i + 1)}`;
                    const body = t.rich(`${k}.body`, { code });
                    return (
                      <li key={k}>
                        {/* Rê chuột hoặc focus vào một bước thì đường của bước đó đậm lên trong sơ đồ. */}
                        <button
                          type="button"
                          aria-pressed={hot === i + 1}
                          onMouseEnter={() => {
                            setHot(i + 1);
                          }}
                          onMouseLeave={() => {
                            setHot(null);
                          }}
                          onFocus={() => {
                            setHot(i + 1);
                          }}
                          onBlur={() => {
                            setHot(null);
                          }}
                          className={`grid w-full cursor-default grid-cols-[28px_minmax(0,1fr)] gap-2.5 rounded-control border-0 p-2 text-left text-ink ${hot === i + 1 ? "bg-surface-2" : "bg-transparent"}`}
                        >
                          <span
                            aria-hidden="true"
                            className="flex size-6 items-center justify-center rounded-[5px] bg-arch-badge font-mono text-[13px] font-bold text-white"
                          >
                            {i + 1}
                          </span>
                          <span className="flex min-w-0 flex-col gap-0.5">
                            <strong className="text-sm">
                              <span className="sr-only">{`${String(i + 1)}. `}</span>
                              {t.rich(`${k}.title`, { code })}
                            </strong>
                            {t.raw(`${k}.body`) === "" ? null : (
                              <span className="text-[13.5px] break-words text-ink-2">{body}</span>
                            )}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ol>
                <div
                  aria-live="polite"
                  className="flex flex-col gap-1.5 border-t border-border pt-3"
                >
                  {node === null || facts === null ? (
                    <p className="m-0 text-sm text-muted">{t("detailHint")}</p>
                  ) : (
                    <>
                      <h3 className="m-0 text-[15px] font-extrabold">{t(`nodes.${node}.label`)}</h3>
                      <dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-[13.5px]">
                        {FACT_KEYS.flatMap((fk) => {
                          const v = facts[fk];
                          return v === undefined
                            ? []
                            : [
                                <dt key={`${fk}-t`} className="text-muted">
                                  {t(`facts.${fk}`)}
                                </dt>,
                                <dd key={`${fk}-d`} className="m-0 break-words">
                                  {v}
                                </dd>,
                              ];
                        })}
                      </dl>
                    </>
                  )}
                </div>
              </aside>
            </div>
          </>
        )}
      </div>
    </Workspace>
  );
}

function Badge({ x, y, n }: { x: number; y: number; n: number }) {
  return (
    <g aria-hidden="true">
      <rect
        x={x - 11}
        y={y - 11}
        width={22}
        height={22}
        rx={4}
        style={{ fill: "var(--arch-badge)" }}
      />
      <text
        x={x}
        y={y + 4.5}
        textAnchor="middle"
        className="fill-white font-mono text-[12px] font-bold"
      >
        {n}
      </text>
    </g>
  );
}
