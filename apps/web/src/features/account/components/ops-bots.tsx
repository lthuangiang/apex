"use client";

import {
  dec,
  type BotSummary,
  type OpsHealth,
  type TeamOpsBot,
  type TeamOpsView,
} from "@drift/shared";
import { cx } from "@drift/ui";
import {
  Archive,
  Check,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  CircleStop,
  Info,
  X,
} from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Fragment, useState, type KeyboardEvent, type ReactNode } from "react";

import { useStateLabel } from "@/features/bots";

import {
  clock,
  compactUsd,
  fixed,
  flagsOf,
  tail,
  usd,
  waitsOf,
  WAIT_KEYS,
  type Flag,
} from "../ops-format";

// Phần bot của trang Bot Monitor (docs/mockups/ops: Main, MarketMaking, VolumeBuilder, RowExpanded, Mobile): tab theo
// chiến lược, bảng (desktop) hoặc thẻ (dưới lg), dòng mở chi tiết, và biểu đồ dưới bảng. Màu không bao giờ là dấu
// hiệu duy nhất: nhãn có biểu tượng + chữ, ô vượt ngưỡng có ▲ / ✕ + chữ cho trình đọc màn hình.

export type Strat = "volume_maker" | "volume_farm";
const STRATS: readonly Strat[] = ["volume_maker", "volume_farm"];

const HEALTH_STYLE: Record<OpsHealth, string> = {
  problem: "bg-neg-bg text-neg-text",
  check: "bg-warn-bg text-warn",
  healthy: "bg-pos-bg text-pos",
  not_running: "bg-surface-2 text-ink-2",
  archived: "bg-surface-2 text-ink-2",
};
const HEALTH_ICON: Record<OpsHealth, ReactNode> = {
  problem: <X aria-hidden="true" size={14} strokeWidth={2.6} />,
  check: <CircleAlert aria-hidden="true" size={14} strokeWidth={2.4} />,
  healthy: <Check aria-hidden="true" size={14} strokeWidth={2.6} />,
  not_running: <CircleStop aria-hidden="true" size={14} strokeWidth={2.4} />,
  archived: <Archive aria-hidden="true" size={14} strokeWidth={2.4} />,
};

export function HealthChip({ health }: { health: OpsHealth }) {
  const t = useTranslations("teamOps.health");
  return (
    <span
      className={cx(
        "inline-flex w-fit items-center gap-1 rounded-full px-2.5 py-1 text-xs font-extrabold whitespace-nowrap",
        HEALTH_STYLE[health],
      )}
    >
      {HEALTH_ICON[health]}
      {t(health)}
    </span>
  );
}

/** Câu lý do của nhãn, giờ theo trình duyệt. */
export function useReasonText(): (x: TeamOpsBot["reasons"][number], r: TeamOpsBot) => string {
  const t = useTranslations("teamOps");
  return (x, r) => {
    const now = Date.now();
    const time = (v: string | null | undefined) =>
      v === null || v === undefined ? "" : clock(v, now);
    switch (x.code) {
      case "alert_active":
        return x.detail === undefined || x.detail === ""
          ? t("reasons.alert_activeNoDetail", { invariant: x.invariant ?? "", time: time(x.at) })
          : t("reasons.alert_active", {
              invariant: x.invariant ?? "",
              time: time(x.at),
              detail: x.detail,
            });
      case "rejected_pause":
        return x.at === null || x.at === undefined
          ? t("reasons.rejected_pauseNoTime")
          : t("reasons.rejected_pause", { time: time(x.at) });
      case "alert_resolved":
        return x.at === null || x.at === undefined
          ? t("reasons.alert_resolvedNoStart", {
              invariant: x.invariant ?? "",
              until: time(x.until),
            })
          : t("reasons.alert_resolved", {
              invariant: x.invariant ?? "",
              time: time(x.at),
              until: time(x.until),
            });
      case "gap_problem":
      case "gap_long":
      case "requests_high":
        return t(`reasons.${x.code}`, { value: x.value ?? "" });
      case "cuts_hour":
        return t("reasons.cuts_hour", { count: x.count ?? 0 });
      case "untracked":
      case "rejects":
        return t(`reasons.${x.code}`, { count: x.count ?? 0, time: time(x.at) });
      case "cost_high":
        return t("reasons.cost_high", {
          value: usd(x.value ?? null) ?? "",
          median: usd(x.median ?? null) ?? "",
          strategy: t(`tabs.${r.strategy}`),
        });
      case "stale_candles":
        return t("reasons.stale_candles", { time: time(x.at) });
    }
  };
}

/** "2 d" / "5 h" / "9 min". */
export function useAgo(): (ms: number) => string {
  const t = useTranslations("teamOps.bot");
  return (ms) => {
    const min = Math.max(0, Math.floor(ms / 60_000));
    if (min < 60) return t("ageMinutes", { count: min });
    const h = Math.floor(min / 60);
    if (h < 24) return t("ageHours", { count: h });
    return t("ageDays", { count: Math.floor(h / 24) });
  };
}

/** Nhãn trạng thái dưới tên bot (Running, Paused by owner, Stopping · 9 min, Stopped 3 h ago…). */
export function useStateText(): (r: TeamOpsBot, now: number) => string {
  const t = useTranslations("teamOps.state");
  const stateLabel = useStateLabel();
  const ago = useAgo();
  return (r, now) => {
    switch (r.state) {
      case "running":
        return t("running");
      case "paused":
        return r.reasonCode === null ? t("pausedOwner") : t("pausedReason", { code: r.reasonCode });
      case "stopping":
        return r.stopAt === null
          ? t("stopping")
          : t("stoppingFor", {
              minutes: Math.max(0, Math.floor((now - Date.parse(r.stopAt)) / 60_000)),
            });
      case "stopped":
        return r.stopAt === null
          ? t("stopped")
          : t("stoppedAgo", { ago: ago(now - Date.parse(r.stopAt)) });
      case "archived":
        return t("archived");
      default:
        return stateLabel({
          state: r.state as BotSummary["state"],
          reasonCode: null,
          needsAttention: false,
        }).label;
    }
  };
}

interface CellView {
  key: string;
  main: string;
  sub?: string | undefined;
  flag?: Flag | undefined;
  muted?: boolean;
  /** Giá trị gọn cho thẻ mobile. */
  short?: string;
}

const MM_COLS = ["cost", "vol", "maker", "req", "gap", "cuts", "untr", "inv", "alert"] as const;
const VB_COLS = [
  "cost",
  "vol",
  "rounds",
  "net",
  "entries",
  "stops",
  "skips",
  "rej",
  "alert",
] as const;
const MM_MOBILE = ["cost", "vol", "inv", "req", "cuts", "alert"] as const;
const VB_MOBILE = ["cost", "vol", "rounds", "entries", "rej", "stops"] as const;
type ColKey = (typeof MM_COLS)[number] | (typeof VB_COLS)[number];

function useCells(): (r: TeamOpsBot) => Record<string, CellView> {
  const t = useTranslations("teamOps");
  return (r) => {
    const now = Date.now();
    const na = t("notAvailable");
    const flags = flagsOf(r);
    const out: Record<string, CellView> = {};
    const set = (key: ColKey, main: string | null, extra: Partial<CellView> = {}) => {
      out[key] = {
        key,
        main: main ?? na,
        muted: main === null,
        flag: flags[key],
        ...extra,
      };
    };
    set(
      "cost",
      usd(r.costPerMillion),
      r.costScope === "lifetime" ? { sub: t("cell.lifetime") } : {},
    );
    const vh = compactUsd(r.volumeHour);
    const vd = compactUsd(r.volumeDay);
    set("vol", vh, { sub: vd ?? na, short: t("cell.pair", { a: vh ?? na, b: vd ?? na }) });
    set(
      "maker",
      r.makerSharePct === null ? null : t("cell.pct", { value: fixed(r.makerSharePct, 1) }),
    );
    const smartOff = r.smartQuoting === false;
    const nOff = {
      main: t("na"),
      sub: t("smartOff"),
      muted: true,
      short: `${t("na")} · ${t("smartOff")}`,
    };
    if (smartOff) {
      out.req = { key: "req", ...nOff };
      out.gap = { key: "gap", ...nOff };
    } else {
      set("req", r.requestsPerMinute === null ? null : fixed(r.requestsPerMinute, 1));
      set("gap", r.maxQuoteGapSec === null ? null : t("cell.sec", { value: r.maxQuoteGapSec }));
    }
    set(
      "cuts",
      String(r.positionCutsDay),
      r.positionCutsDay > 0 ? { sub: t("cell.cutsHour", { count: r.positionCutsHour }) } : {},
    );
    set("untr", String(r.untrackedCancels));
    set("inv", r.positionPct === null ? null : t("cell.pct", { value: fixed(r.positionPct, 0) }), {
      sub: r.positionPct === null ? undefined : t("cell.ofMax"),
    });
    const a = r.alert;
    if (a === null) set("alert", t("none"), { muted: true });
    else if (a.status === "active")
      set("alert", t("cell.alertActive", { invariant: a.invariant }), {
        sub: t("cell.since", { time: clock(a.at, now).slice(0, 5) }),
        flag: "bad",
      });
    else
      set("alert", t("cell.alertResolved", { invariant: a.invariant }), {
        sub: clock(a.at, now).slice(0, 5),
        short: `${t("cell.alertResolved", { invariant: a.invariant })} ${clock(a.at, now).slice(0, 5)}`,
      });
    const vb = r.vb;
    if (vb !== null) {
      const pct =
        vb.rounds === 0 ? null : dec(String(vb.roundsWon)).div(vb.rounds).mul(100).toFixed(0);
      set("rounds", String(vb.rounds), {
        sub: pct === null ? undefined : t("cell.won", { pct }),
        short:
          pct === null ? String(vb.rounds) : t("cell.pair", { a: String(vb.rounds), b: `${pct}%` }),
      });
      set(
        "net",
        vb.avgNet === null
          ? null
          : t("cell.usdc", { value: dec(vb.avgNet).toFixed(2).replace("-", "−") }),
      );
      set(
        "entries",
        t("cell.pair", { a: String(vb.entriesPostOnly), b: String(vb.entriesMarket) }),
        {
          sub: vb.takerAfter === null ? undefined : t("cell.takerAfter", { count: vb.takerAfter }),
        },
      );
      set("stops", String(vb.exits.sodexStop));
      const w = waitsOf(vb);
      set("skips", String(w.total), { sub: w.top === null ? undefined : t(`waits.${w.top}`) });
      set(
        "rej",
        String(vb.marketRejects),
        flags.rej === "bad" ? { sub: t("cell.inARow"), short: t("cell.inARow") } : {},
      );
    }
    return out;
  };
}

function FlagMark({ flag }: { flag: Flag | undefined }) {
  if (flag === undefined) return null;
  return (
    <span aria-hidden="true" className="mr-1 text-[11px]">
      {flag === "bad" ? "✕" : "▲"}
    </span>
  );
}

function FlagText({ flag }: { flag: Flag | undefined }) {
  const t = useTranslations("teamOps.cell");
  if (flag === undefined) return null;
  return <span className="sr-only"> {flag === "bad" ? t("problem") : t("overThreshold")}</span>;
}

const flagBox = (f: Flag | undefined) =>
  f === "bad" ? "bg-neg-bg text-neg-text" : f === "warn" ? "bg-warn-bg text-warn" : "";

export function BotsPanel({
  v,
  tab,
  show,
  isMobile,
  onTab,
  filter,
  pager,
}: {
  v: TeamOpsView | undefined;
  tab: Strat;
  show: "active" | "all";
  isMobile: boolean;
  onTab: (s: Strat) => void;
  filter: ReactNode;
  pager: ReactNode;
}) {
  const t = useTranslations("teamOps");
  const [help, setHelp] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const rows = (v?.bots ?? []).filter((r) => r.strategy === tab);
  const cols = tab === "volume_maker" ? MM_COLS : VB_COLS;
  const s = v?.summary[tab];
  const pick = (x: Strat) => {
    setHelp(null);
    setOpen(null);
    onTab(x);
  };
  const keys = (e: KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const next: Strat = tab === "volume_maker" ? "volume_farm" : "volume_maker";
    pick(next);
    document.getElementById(`ops-tab-${next}`)?.focus();
  };
  const na = t("notAvailable");
  const stats: { v: string; l: string }[] =
    s === undefined
      ? []
      : [
          { v: String(s.running), l: t("stats.running") },
          { v: String(s.paused), l: t("stats.paused") },
          { v: String(s.stopping), l: t("stats.stopping") },
          { v: String(s.stoppedDay), l: t("stats.stoppedDay") },
          { v: usd(s.costPerMillion) ?? na, l: t("stats.cost") },
          ...(tab === "volume_maker"
            ? [
                { v: compactUsd(s.volumeHour) ?? na, l: t("stats.volumeHour") },
                {
                  v:
                    s.makerSharePct === null
                      ? na
                      : t("cell.pct", { value: fixed(s.makerSharePct, 1) }),
                  l: t("stats.maker"),
                },
              ]
            : [
                { v: String(s.rounds), l: t("stats.rounds") },
                {
                  v: s.roundsWonPct === null ? na : t("cell.pct", { value: s.roundsWonPct }),
                  l: t("stats.won"),
                },
              ]),
        ];
  const helpLabel = help === null ? null : t(`cols.${help as ColKey}`);
  return (
    <section
      aria-label={t("tabs.section")}
      className="flex flex-col gap-3 rounded-card border border-border bg-surface p-4"
    >
      {filter}
      <div
        role="tablist"
        aria-label={t("tabs.label")}
        className="inline-flex w-fit rounded-control bg-surface-2 p-1"
      >
        {STRATS.map((x) => (
          <button
            key={x}
            id={`ops-tab-${x}`}
            type="button"
            role="tab"
            aria-selected={x === tab}
            aria-controls="ops-panel"
            tabIndex={x === tab ? 0 : -1}
            onKeyDown={keys}
            onClick={() => {
              pick(x);
            }}
            className={cx(
              "min-h-11 cursor-pointer rounded-[11px] border-0 px-4 text-sm font-extrabold text-ink",
              x === tab ? "bg-surface shadow-sm" : "bg-transparent",
            )}
          >
            {t(`tabs.${x}`)}{" "}
            {v === undefined ? null : (
              <span className="font-semibold text-ink-2">
                {isMobile ? v.counts[x] : t("summary.botCount", { count: v.counts[x] })}
              </span>
            )}
          </button>
        ))}
      </div>
      <div
        id="ops-panel"
        role="tabpanel"
        aria-labelledby={`ops-tab-${tab}`}
        className="flex flex-col gap-3"
      >
        {isMobile ? null : (
          <p className="m-0 max-w-[760px] text-sm text-ink-2">{t(`tabs.intro.${tab}`)}</p>
        )}
        {stats.length === 0 ? null : (
          <div className="flex flex-wrap gap-2">
            {stats.map((x) => (
              <span
                key={x.l}
                className="rounded-control border border-border px-2.5 py-1 text-xs text-ink-2"
              >
                <strong className="text-ink">{x.v}</strong> {x.l}
              </span>
            ))}
          </div>
        )}
        {isMobile ? null : (
          <div aria-live="polite" className="rounded-control bg-accent-tint px-3 py-2 text-sm">
            <strong>
              {helpLabel === null ? t("help.title") : t("help.named", { label: helpLabel })}
            </strong>{" "}
            {help === null ? t("help.idle") : t(`tips.${tab}.${help}` as "tips.volume_maker.cost")}
          </div>
        )}
        {v === undefined ? (
          <div className="flex flex-col gap-2" aria-hidden="true">
            {[1, 2, 3].map((i) => (
              <span key={i} className="block h-12 rounded-control bg-surface-2" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <p className="m-0 py-4 text-sm text-ink-2">
            {show === "all" ? t("noMatch") : t("emptyTitle")}
          </p>
        ) : isMobile ? (
          <Cards rows={rows} tab={tab} open={open} onOpen={setOpen} now={Date.parse(v.checkedAt)} />
        ) : (
          <Table
            rows={rows}
            tab={tab}
            cols={cols}
            help={help}
            onHelp={setHelp}
            open={open}
            onOpen={setOpen}
            now={Date.parse(v.checkedAt)}
          />
        )}
        {pager}
        <p className="m-0 text-xs text-ink-2">{t("order")}</p>
        {v === undefined || rows.length === 0 ? null : tab === "volume_maker" ? (
          <MmCharts rows={rows} />
        ) : (
          <VbCharts rows={rows} />
        )}
      </div>
    </section>
  );
}

function BotName({ r, now }: { r: TeamOpsBot; now: number }) {
  const t = useTranslations("teamOps.bot");
  const stateText = useStateText();
  const ago = useAgo();
  return (
    <span className="flex flex-col gap-0.5">
      <span className="font-bold">{r.name}</span>
      <span className="text-xs text-ink-2">
        {t("meta", { market: r.market, age: ago(now - Date.parse(r.createdAt)) })} ·{" "}
        <Link href={`/admin/users/${r.userId}`} className="text-accent-ink underline">
          {t("owner", { id: tail(r.userId) })}
        </Link>
      </span>
      <span className="w-fit rounded-full bg-surface-2 px-2 py-0.5 text-[11.5px] font-bold text-ink-2">
        {stateText(r, now)}
      </span>
    </span>
  );
}

function Table({
  rows,
  tab,
  cols,
  help,
  onHelp,
  open,
  onOpen,
  now,
}: {
  rows: TeamOpsBot[];
  tab: Strat;
  cols: readonly ColKey[];
  help: string | null;
  onHelp: (k: string | null) => void;
  open: string | null;
  onOpen: (id: string | null) => void;
  now: number;
}) {
  const t = useTranslations("teamOps");
  const cells = useCells();
  return (
    <div className="overflow-x-auto rounded-control border border-border">
      <table className="w-full min-w-[1180px] border-collapse text-sm">
        <caption className="sr-only">{t(`tabs.table.${tab}`)}</caption>
        <thead className="bg-surface-2 text-xs text-ink-2">
          <tr>
            <th scope="col" className="px-3 py-2 text-left">
              {t("cols.health")}
            </th>
            <th scope="col" className="px-3 py-2 text-left">
              {t("cols.bot")}
            </th>
            {cols.map((c) => (
              <th key={c} scope="col" className="px-2 py-2 text-right align-bottom">
                <span className="inline-flex items-center justify-end gap-0.5">
                  <span>{t(`cols.${c}`)}</span>
                  <button
                    type="button"
                    aria-label={t("help.label", { label: t(`cols.${c}`) })}
                    aria-pressed={help === c}
                    onClick={() => {
                      onHelp(help === c ? null : c);
                    }}
                    className={cx(
                      "inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-[8px] border-0",
                      help === c ? "bg-accent text-white" : "bg-transparent text-muted",
                    )}
                  >
                    <Info aria-hidden="true" size={14} />
                  </button>
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const isOpen = open === r.botId;
            const id = `ops-d-${r.botId}`;
            const c = cells(r);
            return (
              <Fragment key={r.botId}>
                <tr className="border-t border-border align-middle">
                  <td className="px-3 py-2">
                    <span className="flex items-center gap-2">
                      <button
                        type="button"
                        aria-expanded={isOpen}
                        aria-controls={id}
                        aria-label={t(isOpen ? "bot.hideDetails" : "bot.showDetails", {
                          name: r.name,
                        })}
                        onClick={() => {
                          onOpen(isOpen ? null : r.botId);
                        }}
                        className="inline-flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-control border border-border bg-surface text-ink"
                      >
                        {isOpen ? (
                          <ChevronUp aria-hidden="true" size={16} />
                        ) : (
                          <ChevronDown aria-hidden="true" size={16} />
                        )}
                      </button>
                      <HealthChip health={r.health} />
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <BotName r={r} now={now} />
                  </td>
                  {cols.map((k) => {
                    const x = c[k];
                    if (x === undefined) return <td key={k} />;
                    return (
                      <td
                        key={k}
                        className={cx("px-2.5 py-2 text-right tabular-nums", flagBox(x.flag))}
                      >
                        <span className="flex flex-col items-end gap-px">
                          <span
                            className={cx(
                              x.muted === true ? "font-medium text-muted" : "font-bold",
                            )}
                          >
                            <FlagMark flag={x.flag} />
                            {x.main}
                          </span>
                          {x.sub === undefined ? null : (
                            <span className="text-[11px] text-ink-2">{x.sub}</span>
                          )}
                          <FlagText flag={x.flag} />
                        </span>
                      </td>
                    );
                  })}
                </tr>
                {isOpen ? (
                  <tr id={id}>
                    <td colSpan={cols.length + 2} className="bg-surface-2 p-3">
                      <Details r={r} />
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Details({ r, mobile = false }: { r: TeamOpsBot; mobile?: boolean }) {
  const t = useTranslations("teamOps");
  const reason = useReasonText();
  const now = Date.now();
  return (
    <div className={cx("grid gap-4", !mobile && "lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]")}>
      <div className="flex flex-col gap-2 text-sm">
        <strong>{mobile ? t("why.mobile") : t(`why.${r.health}`)}</strong>
        <ul className="m-0 flex flex-col gap-1 pl-5">
          {r.reasons.length === 0 ? (
            <li>{t("why.nothing")}</li>
          ) : (
            r.reasons.map((x, i) => <li key={`${x.code}-${String(i)}`}>{reason(x, r)}</li>)
          )}
        </ul>
        <span className="text-xs text-ink-2">
          {t("bot.tail", { tail: tail(r.botId) })}{" "}
          <Link href={`/admin/users/${r.userId}`} className="text-accent-ink underline">
            {t("bot.owner", { id: tail(r.userId) })}
          </Link>
        </span>
      </div>
      <div className="flex flex-col gap-2 text-sm">
        <strong>{t("bot.log")}</strong>
        {r.log.length === 0 ? (
          <span className="text-ink-2">{t("bot.noLog")}</span>
        ) : (
          <ol className="m-0 flex list-none flex-col gap-1 p-0">
            {r.log.map((e, i) => (
              <li
                key={`${e.at}-${String(i)}`}
                className="grid grid-cols-[auto_1fr] gap-x-3 rounded-control bg-surface px-3 py-1.5 lg:grid-cols-[110px_200px_1fr]"
              >
                <span className="text-xs text-ink-2 tabular-nums">{clock(e.at, now)}</span>
                <span className={cx("font-bold", e.alert !== null && "text-neg-text")}>
                  {e.alert === null
                    ? e.name
                    : t(e.alert === "failing" ? "bot.alertFailing" : "bot.alertResolved", {
                        invariant: e.name,
                      })}
                </span>
                <span className="col-span-2 text-ink-2 lg:col-span-1">{e.why ?? ""}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

function Cards({
  rows,
  tab,
  open,
  onOpen,
  now,
}: {
  rows: TeamOpsBot[];
  tab: Strat;
  open: string | null;
  onOpen: (id: string | null) => void;
  now: number;
}) {
  const t = useTranslations("teamOps");
  const cells = useCells();
  const keys = tab === "volume_maker" ? MM_MOBILE : VB_MOBILE;
  const label = (k: ColKey) =>
    k === "gap" || k === "untr" || k === "skips" ? t(`colsMobile.${k}`) : t(`cols.${k}`);
  return (
    <ul aria-label={t(`tabs.table.${tab}`)} className="m-0 flex list-none flex-col gap-2.5 p-0">
      {rows.map((r) => {
        const isOpen = open === r.botId;
        const id = `ops-m-${r.botId}`;
        const c = cells(r);
        return (
          <li
            key={r.botId}
            className="flex flex-col gap-2.5 rounded-card border border-border p-3.5"
          >
            <div className="flex items-start justify-between gap-2">
              <BotName r={r} now={now} />
              <HealthChip health={r.health} />
            </div>
            <dl className="m-0 grid grid-cols-2 gap-1.5">
              {keys.map((k) => {
                const x = c[k];
                if (x === undefined) return null;
                return (
                  <div
                    key={k}
                    className={cx(
                      "flex flex-col gap-px rounded-control px-2 py-1.5",
                      x.flag === undefined ? "bg-surface-2" : flagBox(x.flag),
                    )}
                  >
                    <dt className="text-[11px] text-ink-2">{label(k)}</dt>
                    <dd
                      className={cx(
                        "m-0 text-sm",
                        x.muted === true ? "font-medium text-muted" : "font-extrabold",
                      )}
                    >
                      <FlagMark flag={x.flag} />
                      {x.short ?? x.main}
                      <FlagText flag={x.flag} />
                    </dd>
                  </div>
                );
              })}
            </dl>
            <button
              type="button"
              aria-expanded={isOpen}
              aria-controls={id}
              onClick={() => {
                onOpen(isOpen ? null : r.botId);
              }}
              className="inline-flex min-h-11 cursor-pointer items-center justify-center gap-1.5 rounded-control border border-border bg-surface text-sm font-bold text-ink"
            >
              {isOpen ? (
                <ChevronUp aria-hidden="true" size={16} />
              ) : (
                <ChevronDown aria-hidden="true" size={16} />
              )}
              {t(isOpen ? "bot.hideDetailsShort" : "bot.details")}
            </button>
            {isOpen ? (
              <div id={id}>
                <Details r={r} mobile />
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** Một thanh ngang: độ dài theo %, vạch mốc ở `markPct`. Thanh chỉ để nhìn; số nằm ở chữ bên cạnh. */
function Bar({
  pct,
  markPct,
  flag,
}: {
  pct: number | null;
  markPct: number;
  flag: Flag | undefined;
}) {
  return (
    <span aria-hidden="true" className="relative block h-3 rounded-[5px] bg-surface-2">
      {pct === null ? null : (
        <span
          className={cx(
            "absolute inset-y-0 left-0 rounded-[5px]",
            flag === "bad" ? "bg-neg-text" : flag === "warn" ? "bg-warn-bar" : "bg-accent",
          )}
          style={{ width: `${String(Math.min(100, Math.max(0, pct)))}%` }}
        />
      )}
      <span className="absolute -inset-y-1 w-0.5 bg-ink" style={{ left: `${String(markPct)}%` }} />
    </span>
  );
}

function ChartList({
  title,
  note,
  scale,
  items,
}: {
  title: string;
  note: string;
  scale: string;
  items: {
    key: string;
    name: string;
    pct: number | null;
    mark: number;
    flag: Flag | undefined;
    value: string;
  }[];
}) {
  return (
    <figure className="m-0 flex flex-col gap-2 rounded-control border border-border p-3">
      <figcaption className="flex flex-col gap-0.5">
        <strong className="text-sm">{title}</strong>
        <span className="text-xs text-ink-2">{note}</span>
      </figcaption>
      <div role="list" className="flex flex-col gap-1.5">
        {items.map((x) => (
          <div
            key={x.key}
            role="listitem"
            className="grid grid-cols-[140px_1fr_150px] items-center gap-2 text-xs"
          >
            <span className="truncate font-bold">{x.name}</span>
            <Bar pct={x.pct} markPct={x.mark} flag={x.flag} />
            <span className={cx("text-right", x.pct === null ? "text-muted" : "font-bold")}>
              <FlagMark flag={x.flag} />
              {x.value}
              <FlagText flag={x.flag} />
            </span>
          </div>
        ))}
      </div>
      <span className="text-[11px] text-ink-2">{scale}</span>
    </figure>
  );
}

const pctOf = (v: string | null, max: number) =>
  v === null ? null : dec(v).div(max).mul(100).toNumber();

function MmCharts({ rows }: { rows: TeamOpsBot[] }) {
  const t = useTranslations("teamOps");
  const na = t("notAvailable");
  const byVal = (f: (r: TeamOpsBot) => string | null) =>
    [...rows].sort((a, b) => {
      const x = f(a);
      const y = f(b);
      return x === null ? 1 : y === null ? -1 : dec(y).cmp(dec(x));
    });
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <ChartList
        title={t("charts.reqTitle")}
        note={t("charts.reqNote")}
        scale={t("charts.reqScale")}
        items={byVal((r) => r.requestsPerMinute).map((r) => ({
          key: r.botId,
          name: r.name,
          pct: pctOf(r.requestsPerMinute, 80),
          mark: (55 / 80) * 100,
          flag: flagsOf(r).req,
          value:
            r.requestsPerMinute !== null
              ? t("charts.reqValue", { value: fixed(r.requestsPerMinute, 1) })
              : r.smartQuoting === false
                ? t("charts.smartOff")
                : na,
        }))}
      />
      <ChartList
        title={t("charts.invTitle")}
        note={t("charts.invNote")}
        scale={t("charts.invScale")}
        items={byVal((r) => r.positionPct).map((r) => ({
          key: r.botId,
          name: r.name,
          pct: pctOf(r.positionPct, 125),
          mark: 80,
          flag: flagsOf(r).inv,
          value:
            r.positionPct === null ? na : t("charts.invValue", { value: fixed(r.positionPct, 0) }),
        }))}
      />
    </div>
  );
}

const EXIT_KEYS = [
  "takeProfit",
  "earlyProfit",
  "holdEnded",
  "maxHold",
  "botStop",
  "sodexStop",
] as const;

function VbCharts({ rows }: { rows: TeamOpsBot[] }) {
  const t = useTranslations("teamOps.charts");
  const tc = useTranslations("teamOps.cols");
  const vbs = rows.filter(
    (r): r is TeamOpsBot & { vb: NonNullable<TeamOpsBot["vb"]> } => r.vb !== null,
  );
  return (
    <div className="flex flex-col gap-3">
      <section
        aria-labelledby="ops-entries"
        className="flex flex-col gap-2 rounded-control border border-border p-3"
      >
        <div className="flex flex-col gap-0.5">
          <h3 id="ops-entries" className="m-0 text-sm font-extrabold">
            {t("entriesTitle")}
          </h3>
          <span className="text-xs text-ink-2">{t("entriesNote")}</span>
        </div>
        <div role="list" className="flex flex-col gap-1.5">
          {vbs.map((r) => {
            const tot = r.vb.entriesPostOnly + r.vb.entriesMarket;
            const post = tot === 0 ? 0 : (r.vb.entriesPostOnly / tot) * 100;
            return (
              <div
                key={r.botId}
                role="listitem"
                className="grid grid-cols-[140px_110px_1fr_190px] items-center gap-2 text-xs"
              >
                <span className="truncate font-bold">{r.name}</span>
                <span className="text-ink-2">
                  {r.vb.takerAfter === null
                    ? t("postOnlyOnly")
                    : t("afterMisses", { count: r.vb.takerAfter })}
                </span>
                <span
                  aria-hidden="true"
                  className="flex h-3 overflow-hidden rounded-[5px] bg-surface-2"
                >
                  {tot === 0 ? null : (
                    <>
                      <span className="bg-accent" style={{ width: `${String(post)}%` }} />
                      <span
                        className="bg-[repeating-linear-gradient(45deg,var(--color-warn-bar)_0_4px,transparent_4px_7px)]"
                        style={{ width: `${String(100 - post)}%` }}
                      />
                    </>
                  )}
                </span>
                <span className="text-right">
                  {t("entriesValue", { post: r.vb.entriesPostOnly, market: r.vb.entriesMarket })}
                </span>
              </div>
            );
          })}
        </div>
        <div className="flex gap-4 text-[11px] text-ink-2">
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="size-2.5 rounded-[3px] bg-accent" />
            {t("postOnly")}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="size-2.5 rounded-[3px] bg-[repeating-linear-gradient(45deg,var(--color-warn-bar)_0_2px,transparent_2px_4px)]"
            />
            {t("market")}
          </span>
        </div>
      </section>
      <div className="grid gap-3 xl:grid-cols-2">
        <CountTable
          id="ops-exits"
          title={t("exitsTitle")}
          note={t("exitsNote")}
          foot={t("exitsFoot")}
          bot={tc("bot")}
          heads={EXIT_KEYS.map((k) => t(`exits.${k}`))}
          rows={vbs.map((r) => ({
            key: r.botId,
            name: r.name,
            values: EXIT_KEYS.map((k) => ({ n: r.vb.exits[k] })),
          }))}
        />
        <CountTable
          id="ops-waits"
          title={t("waitsTitle")}
          note={t("waitsNote")}
          foot={t("waitsFoot")}
          bot={tc("bot")}
          heads={WAIT_KEYS.map((k) => t(`waits.${k}`))}
          rows={vbs.map((r) => ({
            key: r.botId,
            name: r.name,
            values: WAIT_KEYS.map((k) => ({
              n: r.vb.waits[k],
              flag: k === "stale" ? flagsOf(r).skips : undefined,
            })),
          }))}
        />
      </div>
    </div>
  );
}

function CountTable({
  id,
  title,
  note,
  foot,
  bot,
  heads,
  rows,
}: {
  id: string;
  title: string;
  note: string;
  foot: string;
  bot: string;
  heads: string[];
  rows: { key: string; name: string; values: { n: number; flag?: Flag | undefined }[] }[];
}) {
  return (
    <section
      aria-labelledby={id}
      className="flex flex-col gap-2 rounded-control border border-border p-3"
    >
      <div className="flex flex-col gap-0.5">
        <h3 id={id} className="m-0 text-sm font-extrabold">
          {title}
        </h3>
        <span className="text-xs text-ink-2">{note}</span>
      </div>
      <div className="overflow-x-auto">
        <table aria-labelledby={id} className="w-full border-collapse text-xs">
          <thead className="text-ink-2">
            <tr>
              <th scope="col" className="px-2 py-1 text-left">
                {bot}
              </th>
              {heads.map((h) => (
                <th key={h} scope="col" className="px-2 py-1 text-right">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-t border-border">
                <th scope="row" className="px-2 py-1.5 text-left font-bold">
                  {r.name}
                </th>
                {r.values.map((x, i) => (
                  <td
                    key={heads[i]}
                    className={cx(
                      "px-2 py-1.5 text-right tabular-nums",
                      x.n === 0 ? "text-muted" : "font-bold",
                      flagBox(x.flag),
                    )}
                  >
                    <FlagMark flag={x.flag} />
                    {x.n}
                    <FlagText flag={x.flag} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <span className="text-[11px] text-ink-2">{foot}</span>
    </section>
  );
}
