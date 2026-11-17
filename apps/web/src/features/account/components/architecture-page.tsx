"use client";

import {
  architectureMapSchema,
  type ArchIcon,
  type ArchitectureMap,
  type ArchTone,
} from "@drift/shared";
import { Button, Skeleton } from "@drift/ui";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useEffect, useId, useState, type KeyboardEvent } from "react";

import { Card, PageHead, Workspace } from "@/components/workspace";
import { api, ApiError } from "@/lib/api";

import { badgeSpots, codeParts, edgesOf, nodesOf, pointAt } from "../architecture-map";

// System Architecture Diagram (team, dưới Market hours): kiểu sơ đồ tham chiếu AWS (icon theo nhóm màu, số bước). Chọn
// một luồng thì đường đi và các bước sáng lên; bấm icon để xem chi tiết. Toàn bộ nội dung (container, cổng, mạng, luồng
// và câu chữ của chúng) lấy từ `GET /api/v1/admin/architecture` (chỉ role team, DevOps PR #211); bundle web chỉ có
// cách vẽ. Người không thuộc team nhận 403 và chỉ thấy câu thông báo.

const TONE: Record<ArchTone, string> = {
  net: "var(--arch-net)",
  app: "var(--arch-app)",
  ml: "var(--arch-ml)",
  db: "var(--arch-db)",
  int: "var(--arch-int)",
  sec: "var(--arch-sec)",
  ext: "var(--arch-ext)",
};

const ZONE: Record<
  ArchitectureMap["groups"][number]["zone"],
  { stroke: string; fill: string; dashed: boolean }
> = {
  internet: { stroke: "var(--arch-ext)", fill: "var(--arch-ext-bg)", dashed: false },
  host: { stroke: "var(--arch-host)", fill: "transparent", dashed: true },
  edge: { stroke: "var(--arch-edge)", fill: "var(--arch-edge-bg)", dashed: false },
  core: { stroke: "var(--arch-core)", fill: "var(--arch-core-bg)", dashed: false },
  secure: { stroke: "var(--arch-secure)", fill: "var(--arch-secure-bg)", dashed: true },
  outside: { stroke: "var(--arch-ext)", fill: "var(--arch-ext-bg)", dashed: false },
};

function Icon({ name }: { name: ArchIcon }) {
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
    case "mail":
      return (
        <>
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="M3 7l9 6 9-6" />
        </>
      );
  }
}

/** Câu có `<code>…</code>` (api gửi) hiện thành chữ + code, không chèn HTML. */
function Rich({ text }: { text: string }) {
  return (
    <>
      {codeParts(text).map((p, i) =>
        p.code ? (
          <code key={i} className="rounded bg-surface-2 px-1 font-mono text-[0.92em]">
            {p.text}
          </code>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

export const ARCHITECTURE_KEY = ["admin", "architecture"] as const;

export function ArchitecturePage() {
  const t = useTranslations("architecture");
  const q = useQuery({
    queryKey: ARCHITECTURE_KEY,
    queryFn: () => api("GET", "/api/v1/admin/architecture", architectureMapSchema),
    staleTime: Infinity,
  });
  const forbidden = q.error instanceof ApiError && q.error.code === "FORBIDDEN";
  return (
    <Workspace current="architecture">
      <div className="flex flex-col gap-4">
        <PageHead title={t("title")} subtitle={t("subtitle")} />
        {forbidden ? (
          <Card>
            <p className="m-0">{t("forbidden")}</p>
          </Card>
        ) : q.isPending ? (
          <div aria-busy="true" className="flex flex-col gap-3">
            <span className="sr-only">{t("loading")}</span>
            <Skeleton className="h-10 w-full max-w-[720px]" />
            <Skeleton className="h-[480px] w-full" />
          </div>
        ) : q.isError ? (
          <Card>
            <div role="alert" className="flex flex-col items-start gap-3">
              <p className="m-0 font-bold">{t("errorTitle")}</p>
              <Button
                variant="tonal"
                onClick={() => {
                  void q.refetch();
                }}
              >
                {t("retry")}
              </Button>
            </div>
          </Card>
        ) : (
          <Diagram map={q.data} />
        )}
      </div>
    </Workspace>
  );
}

function Diagram({ map }: { map: ArchitectureMap }) {
  const t = useTranslations("architecture");
  const isFlow = (v: string) => map.flows.some((f) => f.id === v);
  const [flowId, setFlowId] = useState(map.defaultFlow);
  const [node, setNode] = useState<string | null>(null);
  // Bước đang sáng: rê chuột / focus (tạm thời) thắng bước đã ghim bằng click / Enter / Space (aria-pressed).
  const [hover, setHover] = useState<number | null>(null);
  const [pinned, setPinned] = useState<number | null>(null);
  const hot = hover ?? pinned;
  const uid = useId();
  const arrow = `${uid}-arrow`;

  // Luồng nằm trong hash (#auto, #copy…) để gửi link cho nhau.
  useEffect(() => {
    const read = () => {
      const h = window.location.hash.slice(1);
      if (map.flows.some((f) => f.id === h)) setFlowId(h);
    };
    read();
    window.addEventListener("hashchange", read);
    return () => {
      window.removeEventListener("hashchange", read);
    };
  }, [map]);
  const pick = (f: string) => {
    if (!isFlow(f)) return;
    setFlowId(f);
    setHover(null);
    setPinned(null);
    window.history.replaceState(null, "", `#${f}`);
  };

  const flow = map.flows.find((f) => f.id === flowId) ?? map.flows[0];
  if (flow === undefined) return null;
  const used = nodesOf(map, flow);
  const lines = edgesOf(flow);
  const edgeById = new Map(map.edges.map((e) => [e.id, e]));
  const nodeById = new Map(map.nodes.map((n) => [n.id, n]));
  const hotStep = hot === null ? undefined : flow.steps[hot - 1];
  const hotEdge = hotStep?.edge ?? null;
  const selected = node === null ? undefined : nodeById.get(node);
  const onNodeKey = (e: KeyboardEvent, id: string) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setNode(id);
    }
  };

  return (
    <>
      <nav aria-label={t("flowsLabel")} className="flex flex-wrap gap-2">
        {map.flows.map((f) => (
          <button
            key={f.id}
            type="button"
            aria-pressed={flow.id === f.id}
            onClick={() => {
              pick(f.id);
            }}
            className={`inline-flex min-h-10 items-center gap-2 rounded-control border px-3.5 text-sm font-bold ${
              flow.id === f.id
                ? "border-ink bg-ink text-surface"
                : "border-border bg-surface text-ink"
            }`}
          >
            <span className="font-mono text-[11px] opacity-75">{f.kind}</span>
            {f.title}
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
              viewBox={`0 0 ${String(map.width)} ${String(map.height)}`}
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
              {map.groups.map((g) => {
                const s = ZONE[g.zone];
                return (
                  <g key={`${g.zone}-${String(g.x)}`}>
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
                      {g.label}
                    </text>
                  </g>
                );
              })}
              {map.notes.map((n) =>
                n.boxed ? (
                  <g key={n.text}>
                    <rect
                      x={n.x - 150}
                      y={n.y - 20}
                      width={300}
                      height={32}
                      rx={5}
                      fill="none"
                      className="stroke-border"
                      strokeDasharray="4 3"
                    />
                    <text x={n.x} y={n.y} textAnchor="middle" className="fill-muted text-[12px]">
                      {n.text}
                    </text>
                  </g>
                ) : (
                  <text key={n.text} x={n.x} y={n.y} className="fill-muted text-[12px]">
                    {n.text}
                  </text>
                ),
              )}

              {lines.map((x) => {
                const e = edgeById.get(x.edge);
                if (e === undefined) return null;
                return (
                  <path
                    key={x.edge}
                    d={`M${e.points.map((p) => p.join(" ")).join(" L")}`}
                    fill="none"
                    className="arch-flow"
                    style={{ stroke: "var(--arch-flow)" }}
                    strokeWidth={hotEdge === x.edge ? 4 : 2.2}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    markerEnd={`url(#${arrow})`}
                    markerStart={x.back ? `url(#${arrow})` : undefined}
                  />
                );
              })}

              {map.nodes.map((n) => {
                const isSel = node === n.id;
                // Icon không thuộc luồng: viền + nét màu nhóm trên nền trắng (≥ 3:1), tên màu muted (≥ 4.5:1), không
                // dùng opacity để làm mờ.
                const on = used.has(n.id);
                return (
                  <g
                    key={n.id}
                    role="button"
                    tabIndex={0}
                    aria-label={n.label}
                    aria-pressed={isSel}
                    onClick={() => {
                      setNode(n.id);
                    }}
                    onKeyDown={(e) => {
                      onNodeKey(e, n.id);
                    }}
                    // Safari không vẽ outline cho <g>: vòng focus là một rect riêng hiện khi :focus-visible.
                    className="group cursor-pointer outline-none"
                  >
                    <rect
                      x={n.x - 31}
                      y={n.y - 41}
                      width={62}
                      height={62}
                      rx={10}
                      fill="none"
                      className="stroke-focus opacity-0 group-focus-visible:opacity-100"
                      strokeWidth={3}
                    />
                    <rect
                      x={n.x - 24}
                      y={n.y - 34}
                      width={48}
                      height={48}
                      rx={6}
                      style={
                        on
                          ? { fill: TONE[n.tone] }
                          : { fill: "var(--surface)", stroke: TONE[n.tone] }
                      }
                      strokeWidth={on ? undefined : 1.5}
                    />
                    {isSel ? (
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
                      className={on ? "stroke-surface" : undefined}
                      style={on ? undefined : { stroke: TONE[n.tone] }}
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
                      className={`text-[13px] font-semibold ${on ? "fill-ink" : "fill-muted"}`}
                    >
                      {n.label}
                    </text>
                    <text
                      x={n.x}
                      y={n.y + 45}
                      textAnchor="middle"
                      className="fill-muted font-mono text-[11px]"
                    >
                      {n.sub}
                    </text>
                  </g>
                );
              })}

              {lines.flatMap((x) => {
                const e = edgeById.get(x.edge);
                if (e === undefined) return [];
                return badgeSpots(x.steps.length).map((spot, k) => {
                  const [bx, by] = pointAt(e.points, spot);
                  const num = x.steps[k] ?? 0;
                  return <Badge key={`${x.edge}-${String(num)}`} x={bx} y={by} n={num} />;
                });
              })}
              {flow.steps.map((s, i) => {
                const n = s.node === null ? undefined : nodeById.get(s.node);
                if (n === undefined) return null;
                // Nhiều bước cùng gắn một icon (Pause: engine 3 lần) xếp hàng ngang trên góc phải.
                const before = flow.steps.slice(0, i).filter((x) => x.node === s.node).length;
                return (
                  <Badge key={`n-${String(i)}`} x={n.x + 30 + before * 24} y={n.y - 36} n={i + 1} />
                );
              })}
            </svg>
          </div>
          <ul
            aria-label={t("legendLabel")}
            className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 px-2 pb-1 text-[13px] text-muted"
          >
            {map.legend.map((l) => (
              <li key={l.tone} className="flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="inline-block size-3 rounded-[3px]"
                  style={{ background: TONE[l.tone] }}
                />
                {l.label}
              </li>
            ))}
          </ul>
        </div>

        <aside
          aria-labelledby={`${uid}-flow`}
          className="flex min-w-0 flex-col gap-3 rounded-card border border-border bg-surface p-4"
        >
          <h2 id={`${uid}-flow`} className="m-0 text-lg font-extrabold">
            {flow.title}
          </h2>
          <p className="m-0 text-sm text-ink-2">{flow.lead}</p>
          <ol aria-label={t("stepsLabel")} className="m-0 flex list-none flex-col gap-0.5 p-0">
            {flow.steps.map((s, i) => (
              <li key={`${flow.id}-${String(i)}`}>
                {/* Rê chuột hoặc focus vào một bước thì đường của bước đó đậm lên trong sơ đồ; click / Enter / Space ghim
                    bước đó (bấm lại để bỏ ghim). */}
                <button
                  type="button"
                  aria-pressed={pinned === i + 1}
                  onClick={() => {
                    setPinned((p) => (p === i + 1 ? null : i + 1));
                  }}
                  onMouseEnter={() => {
                    setHover(i + 1);
                  }}
                  onMouseLeave={() => {
                    setHover(null);
                  }}
                  onFocus={() => {
                    setHover(i + 1);
                  }}
                  onBlur={() => {
                    setHover(null);
                  }}
                  className={`grid w-full cursor-pointer grid-cols-[28px_minmax(0,1fr)] gap-2.5 rounded-control border p-2 text-left text-ink ${pinned === i + 1 ? "border-ink" : "border-transparent"} ${hot === i + 1 ? "bg-surface-2" : "bg-transparent"}`}
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
                      <Rich text={s.title} />
                    </strong>
                    {s.body === "" ? null : (
                      <span className="text-[13.5px] break-words text-ink-2">
                        <Rich text={s.body} />
                      </span>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ol>
          <div aria-live="polite" className="flex flex-col gap-1.5 border-t border-border pt-3">
            {selected === undefined ? (
              <p className="m-0 text-sm text-muted">{t("detailHint")}</p>
            ) : (
              <>
                <h3 className="m-0 text-[15px] font-extrabold">{selected.label}</h3>
                <dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-[13.5px]">
                  {selected.facts.flatMap((f) => [
                    <dt key={`${f.label}-t`} className="text-muted">
                      {f.label}
                    </dt>,
                    <dd key={`${f.label}-d`} className="m-0 break-words">
                      <Rich text={f.value} />
                    </dd>,
                  ])}
                </dl>
              </>
            )}
          </div>
        </aside>
      </div>
    </>
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
