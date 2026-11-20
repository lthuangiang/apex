"use client";

import {
  EXPERIMENT_PAIRS,
  type ExperimentVerdict,
  type ResearchExperiment,
  type ResearchVersion,
  type ResearchVersionChange,
  type ResearchVersions,
} from "@drift/shared";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { ScrollTable } from "../components/bits";
import { count, monthDay } from "../format";

import { useHowItWorks } from "./how-it-works";
import { Na, Pill, tdR, tdW, thR, thW, type PillTone } from "./ui";
import { catalystName, changeText, versionShort, type Tn, type Tv } from "./version-text";

// Sổ thí nghiệm (#377, DEC-348 / DEC-351; thiết kế docs/mockups/signal-research/catalyst-experiments-{1440,390}.png,
// catalyst-desktop.html khung 3): khối đầu khu Bots & labels, chia hai nhóm Running và Finished. Chỉ hiện số API trả
// (`experiment` của `GET /versions`); không tự tính kết quả. Desktop là bảng, dưới 768px là thẻ (mockup 390).

/** Màu kết quả (DEC-348 mục 3): Better xanh dương, Worse đỏ nhạt, No clear difference xám, Collecting hổ phách. */
export const VERDICT_TONE: Record<ExperimentVerdict, PillTone> = {
  better: "accent",
  worse: "neg",
  no_clear_difference: "neutral",
  collecting: "warn",
};

export interface ExperimentRow {
  v: ResearchVersion;
  e: ResearchExperiment;
}

export interface ExperimentGroups {
  /** Version (không phải Baseline) đang chạy hoặc tạm dừng, chưa Finished, cũ trước. */
  running: ExperimentRow[];
  /** Version đã tự dừng vì đủ cặp (`finishedAt`), mới dừng trước. */
  finished: ExperimentRow[];
  /** Số thí nghiệm đang chạy thật (trạng thái `running`). */
  runningCount: number;
  /** "Not a clean test" trong hai nhóm (`clean === false`; null = không biết, không đếm). */
  unclean: number;
}

/** Chia version thành Running / Finished. Version dừng tay (chưa Finished) không thuộc nhóm nào (vẫn ở All versions). */
export function experimentGroups(items: readonly ResearchVersion[]): ExperimentGroups {
  const rows: ExperimentRow[] = [];
  for (const v of items)
    if (!v.isBaseline && v.experiment !== null) rows.push({ v, e: v.experiment });
  // Running theo thứ tự lưu (mockup: v4 rồi v5); Finished mới dừng trước (v8, v7, v6).
  const running = rows
    .filter((r) => r.e.finishedAt === null && (r.v.status === "running" || r.v.status === "paused"))
    .sort((a, b) => a.v.number - b.v.number);
  const finished = rows
    .filter((r) => r.e.finishedAt !== null)
    .sort((a, b) => Date.parse(b.e.finishedAt ?? "") - Date.parse(a.e.finishedAt ?? ""));
  return {
    running,
    finished,
    runningCount: running.filter((r) => r.v.status === "running").length,
    unclean: [...running, ...finished].filter((r) => r.e.clean === false).length,
  };
}

/** Tên một "thứ" đã đổi (cảnh báo "Changes 2 things from Baseline: Lowest level, Assets"). */
function thingNames(changes: readonly ResearchVersionChange[], t: Tx, tn: Tn): string[] {
  const out: string[] = [];
  for (const c of changes) {
    const name =
      c.field === "newsType"
        ? catalystName(c.catalyst, tn)
        : c.field === "assetMode" || c.field === "assetKinds" || c.field === "assets"
          ? t("thing.assets")
          : t(`thing.${c.field}`);
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

type Tx = ReturnType<typeof useTranslations<"signalAnalysis.research.experiments">>;

const link =
  "cursor-pointer border-0 bg-transparent p-0 font-semibold text-accent-ink underline-offset-2 hover:underline focus-visible:underline";

export function Experiments({
  data,
  tz,
  onCopy,
}: {
  data: ResearchVersions;
  tz: string;
  /** "Copy to new version" của dòng "Not a clean test": mở sheet New version chép từ version đó. */
  onCopy: (v: ResearchVersion) => void;
}) {
  const t = useTranslations("signalAnalysis.research.experiments");
  const tn = useTranslations("signalAnalysis.research");
  const how = useHowItWorks();
  const g = experimentGroups(data.items);
  const baseline = data.items.find((v) => v.isBaseline) ?? null;
  const control = baseline?.number ?? g.running[0]?.e.control.number ?? null;
  const free = data.maxRunning - data.running;
  const needed = g.running[0]?.e.needed ?? g.finished[0]?.e.needed ?? EXPERIMENT_PAIRS;
  const ctx: RowCtx = {
    tz,
    readerChecked: data.classifier.passes,
    onCopy,
  };
  return (
    <section aria-labelledby="sr-experiments-title" className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 id="sr-experiments-title" className="m-0 text-[17px] font-extrabold">
          {t("title")}
        </h3>
        <span className="text-xs text-muted">{t("tagline")}</span>
      </div>
      <p className="m-0 text-[13px] leading-normal text-ink-2">
        {t("intro", {
          n: control === null ? tn("na") : String(control),
          pairs: needed,
          max: data.maxRunning,
        })}
        {how === null ? null : (
          <>
            {" "}
            <button
              type="button"
              className={link}
              onClick={() => {
                how("experiments");
              }}
            >
              {t("how")}
            </button>
          </>
        )}
      </p>

      <GroupHead
        title={t("runningTitle", {
          n: g.runningCount,
          used: data.running,
          max: data.maxRunning,
        })}
        side={free > 0 ? t("free", { k: free }) : t("full")}
      />
      {g.running.length === 0 ? (
        <p className="m-0 text-sm text-muted">{t("noneRunning")}</p>
      ) : (
        <Rows rows={g.running} finished={false} ctx={ctx} label={t("runningTable")} />
      )}

      <div className="border-t border-border pt-3">
        <GroupHead
          title={t("finishedTitle", { n: g.finished.length })}
          side={t("finishedSub", { n: needed })}
        />
      </div>
      {g.finished.length === 0 ? (
        <p className="m-0 text-sm text-muted">{t("noneFinished")}</p>
      ) : (
        <Rows rows={g.finished} finished ctx={ctx} label={t("finishedTable")} />
      )}
    </section>
  );
}

function GroupHead({ title, side }: { title: string; side: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
      <h4 className="m-0 text-[15px] font-extrabold">{title}</h4>
      <span className="text-xs text-muted">{side}</span>
    </div>
  );
}

interface RowCtx {
  tz: string;
  /** Classifier hiện tại đã qua cổng nhãn; false → "Claude reader not yet checked" cạnh kết quả (DEC-351 mục 3). */
  readerChecked: boolean;
  onCopy: (v: ResearchVersion) => void;
}

function Rows({
  rows,
  finished,
  ctx,
  label,
}: {
  rows: readonly ExperimentRow[];
  finished: boolean;
  ctx: RowCtx;
  label: string;
}) {
  return (
    <>
      <div className="max-md:hidden">
        <ExperimentTable rows={rows} finished={finished} ctx={ctx} label={label} />
      </div>
      <ul aria-label={label} className="m-0 flex list-none flex-col gap-2 p-0 md:hidden">
        {rows.map((r) => (
          <ExperimentCard key={r.v.id} r={r} finished={finished} ctx={ctx} />
        ))}
      </ul>
    </>
  );
}

function ResultCell({ e, ctx }: { e: ResearchExperiment; ctx: RowCtx }) {
  const t = useTranslations("signalAnalysis.research.experiments");
  return (
    <>
      <Pill tone={VERDICT_TONE[e.verdict]}>{t(`verdict.${e.verdict}`)}</Pill>
      {ctx.readerChecked ? null : (
        <span className="mt-1 block text-xs text-muted">{t("readerNotChecked")}</span>
      )}
    </>
  );
}

/** Ô thay đổi so với Baseline: "Change: SL 0.75× → 1.0×" / "Changes: a · b"; null config → Not available. */
function changeLine(r: ExperimentRow, t: Tx, tv: Tv, tn: Tn): string | null {
  const ch = r.e.changes;
  if (ch === null) return null;
  if (ch.length === 0) return t("noChange");
  const list = ch.map((c) => changeText(c, r.v.config, tv, tn));
  return list.length === 1
    ? t("change", { change: list[0] ?? "" })
    : t("changes", { list: list.join(" · ") });
}

function NotClean({
  r,
  ctx,
  withCopy,
}: {
  r: ExperimentRow;
  ctx: RowCtx;
  /** Mockup 390 không có link "Copy to new version". */
  withCopy: boolean;
}) {
  const t = useTranslations("signalAnalysis.research.experiments");
  const tn = useTranslations("signalAnalysis.research");
  const ch = r.e.changes ?? [];
  const names = thingNames(ch, t, tn);
  const b = (c: ReactNode) => <b className="text-ink">{c}</b>;
  const copy = (c: ReactNode) =>
    withCopy ? (
      <button
        type="button"
        className={link}
        onClick={() => {
          ctx.onCopy(r.v);
        }}
      >
        {c}
      </button>
    ) : (
      c
    );
  return (
    <p className="m-0 rounded-tile border border-warn-border bg-warn-bg px-3 py-2.5 text-[13px] leading-normal text-warn">
      {names.length === 0
        ? t.rich(withCopy ? "notCleanNone" : "notCleanNoneShort", { b, copy })
        : t.rich(withCopy ? "notClean" : "notCleanShort", {
            n: r.e.changedThings ?? names.length,
            fields: names.join(", "),
            b,
            copy,
          })}
    </p>
  );
}

function ExperimentTable({
  rows,
  finished,
  ctx,
  label,
}: {
  rows: readonly ExperimentRow[];
  finished: boolean;
  ctx: RowCtx;
  label: string;
}) {
  const t = useTranslations("signalAnalysis.research.experiments");
  const tv = useTranslations("signalAnalysis.research.versions");
  const tn = useTranslations("signalAnalysis.research");
  const br = () => <br />;
  return (
    <ScrollTable label={label}>
      <table className="w-full border-collapse">
        <caption className="sr-only">{label}</caption>
        <thead>
          <tr>
            <th scope="col" className={thR}>
              {t("cols.hypothesis")}
            </th>
            <th scope="col" className={thR}>
              {t("cols.version")}
            </th>
            <th scope="col" className={thR}>
              {t("cols.started")}
            </th>
            {finished ? (
              <th scope="col" className={thR}>
                {t("cols.stopped")}
              </th>
            ) : null}
            <th scope="col" className={thR}>
              {t("cols.measured")}
            </th>
            <th scope="col" className={thW}>
              {t.rich("cols.pairs", { br })}
            </th>
            <th scope="col" className={thR}>
              {t("cols.result")}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const unclean = r.e.clean === false;
            const line = changeLine(r, t, tv, tn);
            return (
              <tr key={r.v.id} className={unclean ? "bg-warn-bg" : undefined}>
                <td className={`${tdW} min-w-[300px]`}>
                  {r.v.hypothesis === null ? null : (
                    <span className="font-bold">{r.v.hypothesis}</span>
                  )}
                  {unclean ? (
                    <div className={r.v.hypothesis === null ? undefined : "mt-2"}>
                      <NotClean r={r} ctx={ctx} withCopy />
                    </div>
                  ) : null}
                </td>
                <th scope="row" className={`${tdW} min-w-[150px] font-normal`}>
                  <b className="block">{versionShort(r.v, tv)}</b>
                  {r.v.status === "paused" ? (
                    <span className="mt-0.5 block">
                      <Pill tone="neutral">{tv("state.paused")}</Pill>
                    </span>
                  ) : null}
                  <span className="block text-xs text-muted">
                    {t("vsBaseline", { n: r.e.control.number })}
                  </span>
                  <span className="block text-xs text-muted">{line ?? <Na />}</span>
                </th>
                <td className={tdR}>{monthDay(r.v.createdAt, ctx.tz)}</td>
                {finished ? (
                  <td className={tdR}>
                    {r.e.finishedAt === null ? <Na /> : monthDay(r.e.finishedAt, ctx.tz)}
                  </td>
                ) : null}
                <td className={`${tdW} min-w-[150px]`}>{t("measuredBy")}</td>
                <td className={tdR}>
                  {t("pairsValue", { have: count(r.e.pairs), need: count(r.e.needed) })}
                </td>
                <td className={`${tdW} min-w-[140px]`}>
                  <ResultCell e={r.e} ctx={ctx} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </ScrollTable>
  );
}

function ExperimentCard({
  r,
  finished,
  ctx,
}: {
  r: ExperimentRow;
  finished: boolean;
  ctx: RowCtx;
}) {
  const t = useTranslations("signalAnalysis.research.experiments");
  const tv = useTranslations("signalAnalysis.research.versions");
  const tn = useTranslations("signalAnalysis.research");
  const unclean = r.e.clean === false;
  const ch = r.e.changes;
  const list = ch === null ? null : ch.map((c) => changeText(c, r.v.config, tv, tn));
  const n = r.e.control.number;
  const vs =
    list === null
      ? `${t("vsBaseline", { n })} · ${tn("na")}`
      : list.length === 0
        ? `${t("vsBaseline", { n })} · ${t("noChange")}`
        : list.length === 1
          ? t("mOneChange", { n, change: list[0] ?? "" })
          : t("mChanges", { n, list: list.join(" · ") });
  const have = count(r.e.pairs);
  const need = count(r.e.needed);
  const start = monthDay(r.v.createdAt, ctx.tz);
  return (
    <li
      className={`flex flex-col gap-1.5 rounded-tile border bg-surface p-3 text-[13px] ${unclean ? "border-warn-border" : "border-border"}`}
    >
      <div className="flex items-start justify-between gap-1.5">
        <b>
          {versionShort(r.v, tv)}
          {r.v.status === "paused" ? (
            <span className="ml-1.5 align-middle">
              <Pill tone="neutral">{tv("state.paused")}</Pill>
            </span>
          ) : null}
        </b>
        <span className="flex-none text-right">
          <ResultCell e={r.e} ctx={ctx} />
        </span>
      </div>
      {r.v.hypothesis === null ? null : <span className="font-bold">{r.v.hypothesis}</span>}
      <span className="text-xs text-muted">{vs}</span>
      <span className="text-xs text-muted">
        {finished
          ? t("mFinished", {
              start,
              stop: r.e.finishedAt === null ? tn("na") : monthDay(r.e.finishedAt, ctx.tz),
              have,
              need,
            })
          : t("mSince", { start, have, need })}
      </span>
      {unclean ? (
        <div className="mt-1">
          <NotClean r={r} ctx={ctx} withCopy={false} />
        </div>
      ) : null}
    </li>
  );
}

/** Dòng phụ của Bots & labels khi gập: "2 experiments running · 1 not a clean test · 3 finished". */
export function experimentsMeta(
  items: readonly ResearchVersion[],
  t: ReturnType<typeof useTranslations<"signalAnalysis.research.botsLabels">>,
): string {
  const g = experimentGroups(items);
  return t("metaExperiments", {
    running: g.runningCount,
    unclean: g.unclean,
    finished: g.finished.length,
  });
}
