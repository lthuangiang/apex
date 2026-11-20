"use client";

import {
  type ResearchClassifierRow,
  type ResearchVersion,
  type ResearchVersions,
} from "@drift/shared";
import { Button, ConfirmDialog } from "@drift/ui";
import { useTranslations } from "next-intl";
import { useMemo, useState, type ReactNode } from "react";

import { ApiError } from "@/lib/api";
import { uncertainOutcome } from "@/lib/financial-action";

import { ScrollTable } from "../components/bits";
import { count, monthDay, clock } from "../format";

import {
  useCreateVersion,
  useResearchClassifiers,
  useResearchMarkets,
  useResearchVersions,
  useVersionStatus,
  type VersionStatusVars,
} from "./api";
import { useBotsLabels } from "./bots-labels-context";
import { balance, pctSigned, tone, usdSigned } from "./format";
import { NotEnough, Pill, tdR, tdW, thR, thW, type PillTone } from "./ui";
import { saveErrorText, VersionSheet, type SheetMode } from "./version-sheet";
import {
  changedCell,
  classifierShort,
  classifiersUsed,
  configLine,
  effectiveNote,
  gateLines,
  gateText,
  savedLine,
  versionShort,
  versionTitle,
} from "./version-text";

// Khối Paper bots với News bot versions (#306; thiết kế docs/mockups/signal-research/bot-versions.html, API #305):
// thanh tóm tắt, cảnh báo kiểm tra thêm, thẻ các version đang chạy / tạm dừng, ô "One more slot", bảng mọi version. Chọn
// một version (tiêu đề thẻ hoặc ô Version của bảng) đổi `versionId` của tổng kết, News feed, trace và bảng Trades.

const STATE_TONE: Record<ResearchVersion["status"], PillTone> = {
  // Trạng thái chạy là trung tính (xanh dương); xanh lá chỉ cho lệnh đã vào / có lãi (trang gọn, 2026-11-20).
  running: "accent",
  paused: "neutral",
  stopped: "neutral",
  retired: "neutral",
};

const btn =
  "inline-flex min-h-11 items-center rounded-control border border-border-input bg-surface px-4 text-sm font-bold text-ink no-underline hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-60";

export function NewsVersions({
  tz,
  selected,
  onSelect,
  others,
  unrealized,
}: {
  tz: string;
  /** Version đang xem ở dưới; null = Baseline (mặc định của API). */
  selected: string | null;
  onSelect: (id: string) => void;
  /** Thẻ bot replay (Whales, Funding · Price patterns) giữ như trước. */
  others: ReactNode;
  /**
   * #297: lãi / lỗ chưa chốt của bot News trong tổng kết (theo giá SoDEX gần nhất), chỉ của version tổng kết đang mô tả;
   * null = không có (không cộng một phần).
   */
  unrealized: { versionId: string; value: string | null } | null;
}) {
  const t = useTranslations("signalAnalysis.research.versions");
  const tbl = useTranslations("signalAnalysis.research.botsLabels");
  const tc = useTranslations("common.errors");
  const q = useResearchVersions();
  const cls = useResearchClassifiers();
  const [sheet, setSheet] = useState<SheetMode | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const markets = useResearchMarkets(sheet?.kind === "new" || sheet?.kind === "rules");
  const create = useCreateVersion((v) => {
    setSheet(null);
    setSaveError(null);
    setNotice(
      v.warnings.includes("market_list_stale")
        ? t("staleNotice", { n: v.number, name: v.name })
        : t("savedNotice", { n: v.number, name: v.name }),
    );
    onSelect(v.id);
  });
  const labels = useMemo(
    () =>
      new Map<string, ResearchClassifierRow>(
        (cls.data?.items ?? []).map((r) => [r.classifierVersion, r]),
      ),
    [cls.data],
  );
  const data = q.data;

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h3 className="m-0 text-[17px] font-extrabold">{tbl("versionsTitle")}</h3>
      <div>
        <Button
          disabled={data === undefined}
          onClick={() => {
            setSaveError(null);
            setSheet({ kind: "new", from: null });
          }}
        >
          {t("new")}
        </Button>
      </div>
    </div>
  );

  if (data === undefined)
    return (
      <>
        {header}
        {q.isError ? (
          <p role="alert" className="m-0 flex flex-wrap items-center gap-3 text-sm text-neg-ink">
            {t("error")}
            <button type="button" className={btn} onClick={() => void q.refetch()}>
              {tc("retry")}
            </button>
          </p>
        ) : (
          <p className="m-0 text-sm text-muted">{t("loading")}</p>
        )}
        {others}
      </>
    );

  const baseline = data.items.find((v) => v.isBaseline) ?? null;
  const current = selected ?? baseline?.id ?? null;
  const active = data.items.filter((v) => v.status === "running" || v.status === "paused");
  const slots = data.maxRunning - data.running;
  const next = Math.max(0, ...data.items.map((v) => v.number)) + 1;

  return (
    <>
      {header}
      <Bar data={data} />
      {data.extraCheck ? (
        <p className="m-0 rounded-tile bg-warn-bg px-4 py-3 text-sm leading-normal text-warn">
          {t.rich("extraCheck", { n: data.repeatTrades, b: (c: ReactNode) => <b>{c}</b> })}
        </p>
      ) : null}
      {notice === null ? null : (
        <p role="status" className="m-0 text-sm font-semibold text-pos">
          {notice}
        </p>
      )}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(290px,1fr))] gap-3.5">
        {active.map((v) => (
          <VersionCard
            key={v.id}
            v={v}
            tz={tz}
            labels={labels}
            selected={v.id === current}
            unrealized={unrealized?.versionId === v.id ? unrealized.value : null}
            onSelect={() => {
              onSelect(v.id);
            }}
            onCopy={() => {
              setSaveError(null);
              setSheet({ kind: "new", from: v });
            }}
            onRules={() => {
              setSheet({ kind: "rules", of: v });
            }}
          />
        ))}
        {slots > 0 ? (
          <div className="flex flex-col justify-center gap-2.5 rounded-tile border border-dashed border-border-input bg-surface-2 p-4">
            <h3 className="m-0 text-[17px] font-extrabold">{t("slots", { n: slots })}</h3>
            <p className="m-0 text-[13px] leading-normal text-ink-2">{t("slotsBody")}</p>
            <div>
              <button
                type="button"
                className={`${btn} border-accent text-accent-ink`}
                onClick={() => {
                  setSaveError(null);
                  setSheet({ kind: "new", from: null });
                }}
              >
                {t("new")}
              </button>
            </div>
          </div>
        ) : null}
      </div>
      <AllVersions
        items={data.items}
        tz={tz}
        labels={labels}
        current={current}
        onSelect={onSelect}
      />
      {others}
      {sheet === null ? null : (
        <VersionSheet
          key={sheet.kind === "rules" ? `r-${sheet.of.id}` : `n-${sheet.from?.id ?? "new"}`}
          mode={sheet}
          next={next}
          running={data.running}
          maxRunning={data.maxRunning}
          markets={{
            data: markets.data,
            loading: markets.isPending && markets.fetchStatus !== "idle",
            error: markets.isError,
          }}
          baseline={baseline}
          pending={create.isPending}
          checking={create.checking}
          error={saveError}
          onClose={() => {
            setSheet(null);
          }}
          onSave={(body) => {
            setSaveError(null);
            create.mutate(body, {
              onError: (e) => {
                setSaveError(saveErrorText(e, t, tc("unconfirmed")));
              },
            });
          }}
        />
      )}
    </>
  );
}

function Bar({ data }: { data: ResearchVersions }) {
  const t = useTranslations("signalAnalysis.research.versions");
  const tn = useTranslations("signalAnalysis.research");
  const open = useBotsLabels();
  const b = (c: ReactNode) => <b>{c}</b>;
  const c = data.classifier;
  const name = classifierShort(c.current);
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-1.5 rounded-tile bg-surface-2 px-4 py-3 text-sm text-ink-2">
      <span>{t.rich("running", { n: data.running, max: data.maxRunning, b })}</span>
      <b className="text-ink">{t("tried", { n: data.versionsTried })}</b>
      <span>
        {c.labeled === 0 || c.precisionPct === null
          ? t("classifierNone", { name })
          : t("classifier", {
              name,
              pct: `${String(Math.round(c.precisionPct))}%`,
              n: c.labeled,
            })}
        {tn("trades.sep")}
        {open === null ? (
          <a href="#sr-labels" className="font-semibold text-accent-ink underline">
            {t("labelMore")}
          </a>
        ) : (
          <button
            type="button"
            onClick={open.openLabels}
            className="cursor-pointer border-0 bg-transparent p-0 font-semibold text-accent-ink underline"
          >
            {t("labelMore")}
          </button>
        )}
      </span>
    </div>
  );
}

function VersionCard({
  v,
  tz,
  labels,
  selected,
  unrealized,
  onSelect,
  onCopy,
  onRules,
}: {
  v: ResearchVersion;
  tz: string;
  labels: ReadonlyMap<string, ResearchClassifierRow>;
  selected: boolean;
  unrealized: string | null;
  onSelect: () => void;
  onCopy: () => void;
  onRules: () => void;
}) {
  const t = useTranslations("signalAnalysis.research.versions");
  const tb = useTranslations("signalAnalysis.research.bots");
  const tn = useTranslations("signalAnalysis.research");
  const ts = useTranslations("states");
  const status = useVersionStatus();
  const [stopAsk, setStopAsk] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const tc = useTranslations("common.errors");
  const pendingTo = status.isPending ? status.variables.status : null;
  const act = (to: VersionStatusVars["status"]) => {
    setErr(null);
    status.mutate(
      { id: v.id, status: to },
      {
        onSuccess: () => {
          setStopAsk(false);
        },
        onError: (e) => {
          setErr(
            uncertainOutcome(e) !== null
              ? tc("unconfirmed")
              : e instanceof ApiError && e.details.reason === "MAX_RUNNING_VERSIONS"
                ? t("errors.maxRunning")
                : t("errors.generic"),
          );
        },
      },
    );
  };
  const eff = effectiveNote(v);
  const max = v.effectiveMaxOpen ?? v.maxOpenTrades;
  const lines = gateLines(v, labels, tz, t);
  const title = versionTitle(v, t);
  return (
    <article
      aria-label={title}
      className={`flex flex-col gap-2.5 rounded-tile border-2 p-4 ${selected ? "border-accent" : "border-border"}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="m-0 text-[17px] font-extrabold">
            <button
              type="button"
              aria-pressed={selected}
              title={t("show", { name: title })}
              onClick={onSelect}
              className="cursor-pointer border-0 bg-transparent p-0 text-left font-extrabold text-ink hover:underline"
            >
              {title}
            </button>
          </h3>
          <span className="block text-xs text-muted">{savedLine(v, tz, t)}</span>
        </div>
        <Pill tone={STATE_TONE[v.status]}>{t(`state.${v.status}`)}</Pill>
      </div>
      <p className="m-0 text-[13px] leading-normal text-ink-2">{configLine(v, t)}</p>
      <dl className="m-0 grid grid-cols-3 gap-2">
        <Stat
          label={tb("balance")}
          value={
            <>
              {balance(v.balance)}
              {unrealized === null ? null : (
                <span className={`block text-xs font-bold ${tone(Number(unrealized))}`}>
                  {tb("unrealized", { pnl: usdSigned(unrealized) })}
                </span>
              )}
            </>
          }
        />
        <Stat label={t("closed")} value={count(v.closed)} />
        <Stat
          label={t("count")}
          value={
            v.gate.classifierStatus === "needsLabels" ? (
              <span className="text-[13px]">{t("waitsForLabels", { k: v.gate.labelsToGo })}</span>
            ) : v.gate.classifierStatus === "underPrecision" ? (
              <span className="text-[13px]">{t("countUnder")}</span>
            ) : (
              count(v.counted)
            )
          }
        />
      </dl>
      <p className="m-0 text-[13px] text-ink-2">
        {t.rich("openLine", {
          open: v.openTrades,
          max: max ?? tn("na"),
          today: v.todayTrades,
          // null = Off; config không đọc được thì không biết giới hạn (quy tắc 1.8).
          limit:
            v.config === null
              ? tn("na")
              : v.maxNewTradesPerDay === null
                ? t("noLimit")
                : t("dayLimit", { n: v.maxNewTradesPerDay }),
          blocked: v.blockedByLimit,
          b: (c: ReactNode) => <b className="text-ink">{c}</b>,
        })}
        {eff === null ? null : (
          <span className="block text-xs">{t("effectively", { n: eff })}</span>
        )}
      </p>
      {lines.length === 0 ? null : (
        <p className="m-0 text-xs leading-normal text-warn">{lines.join(" ")}</p>
      )}
      <div className="flex flex-wrap gap-2">
        {v.status === "running" ? (
          <button
            type="button"
            className={btn}
            disabled={status.isPending}
            aria-busy={pendingTo === "paused" || undefined}
            onClick={() => {
              act("paused");
            }}
          >
            {pendingTo === "paused" ? ts("pausing") : t("pause")}
          </button>
        ) : (
          <button
            type="button"
            className={btn}
            disabled={status.isPending}
            aria-busy={pendingTo === "running" || undefined}
            onClick={() => {
              act("running");
            }}
          >
            {pendingTo === "running" ? ts("resuming") : t("resume")}
          </button>
        )}
        <button
          type="button"
          className={btn}
          disabled={status.isPending}
          onClick={() => {
            setErr(null);
            setStopAsk(true);
          }}
        >
          {pendingTo === "stopped" ? ts("stopping") : t("stop")}
        </button>
        <button type="button" className={btn} onClick={onCopy}>
          {v.isBaseline ? t("copy") : t("edit")}
        </button>
        <button type="button" className={btn} onClick={onRules}>
          {t("rules")}
        </button>
      </div>
      {status.checking ? (
        <p role="status" className="m-0 text-xs font-semibold text-ink-2">
          {tc("unconfirmed")}
        </p>
      ) : err === null ? null : (
        <p role="alert" className="m-0 text-xs font-semibold text-neg-ink">
          {err}
        </p>
      )}
      <ConfirmDialog
        open={stopAsk}
        onOpenChange={(o) => {
          if (!status.isPending) setStopAsk(o);
        }}
        title={t("stopTitle", { n: v.number, name: v.name })}
        consequencesLabel={t("stopWhat")}
        consequences={[t("stopNoNew"), t("stopFinal")]}
        confirmLabel={t("stopConfirm", { n: v.number })}
        cancelLabel={t("cancel")}
        tone="danger"
        pending={pendingTo === "stopped"}
        pendingLabel={ts("stopping")}
        {...(err === null ? {} : { error: err })}
        onConfirm={() => {
          act("stopped");
        }}
      />
    </article>
  );
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-bold text-muted">{label}</dt>
      <dd className="m-0 font-extrabold">{value}</dd>
    </div>
  );
}

function AllVersions({
  items,
  tz,
  labels,
  current,
  onSelect,
}: {
  items: readonly ResearchVersion[];
  tz: string;
  labels: ReadonlyMap<string, ResearchClassifierRow>;
  current: string | null;
  onSelect: (id: string) => void;
}) {
  const t = useTranslations("signalAnalysis.research.versions");
  const tn = useTranslations("signalAnalysis.research");
  const cols = [
    "version",
    "state",
    "saved",
    "changed",
    "classifier",
    "closed",
    "blocked",
    "avg",
    "gate",
  ] as const;
  return (
    <div className="flex flex-col gap-2">
      <h3 className="m-0 text-[17px] font-extrabold">{t("all")}</h3>
      <ScrollTable label={t("allTable")}>
        <table className="w-full border-collapse">
          <caption className="sr-only">{t("allTable")}</caption>
          <thead>
            <tr>
              {cols.map((k) => (
                <th key={k} scope="col" className={k === "blocked" || k === "avg" ? thW : thR}>
                  {t(`cols.${k}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((v) => {
              const used = classifiersUsed(v);
              return (
                <tr key={v.id} className={v.id === current ? "bg-surface-2" : undefined}>
                  <th scope="row" className={`${tdW} min-w-[120px] font-bold`}>
                    <button
                      type="button"
                      aria-pressed={v.id === current}
                      onClick={() => {
                        onSelect(v.id);
                      }}
                      className="cursor-pointer border-0 bg-transparent p-0 text-left font-bold text-ink hover:underline"
                    >
                      {versionShort(v, t)}
                    </button>
                  </th>
                  <td className={tdR}>{t(`state.${v.status}`)}</td>
                  <td className={tdR}>
                    {t("savedAt", {
                      date: monthDay(v.createdAt, tz),
                      time: clock(v.createdAt, tz, false),
                    })}
                  </td>
                  <td className={`${tdW} min-w-[200px]`}>{changedCell(v, t, tn)}</td>
                  <td className={tdR}>
                    {used ?? <span className="text-muted">{tn("dash")}</span>}
                  </td>
                  <td className={tdR}>
                    {v.counted < v.closed
                      ? t("closedCounted", { closed: count(v.closed), counted: count(v.counted) })
                      : count(v.closed)}
                  </td>
                  <td className={tdR}>{count(v.blockedByLimit)}</td>
                  <td className={tdR}>
                    {v.avgPct === null ? (
                      <NotEnough />
                    ) : (
                      <span className={`font-bold ${tone(v.avgPct)}`}>{pctSigned(v.avgPct)}</span>
                    )}
                  </td>
                  <td className={`${tdW} min-w-[160px]`}>{gateText(v, labels, t)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </ScrollTable>
    </div>
  );
}
