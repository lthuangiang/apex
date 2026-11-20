"use client";

import {
  CLASSIFICATION_WRONG_REASONS,
  ErrorCode,
  type ClassificationVerdict,
  type ClassificationWrongReason,
  type ResearchClassifierRow,
  type ResearchLabelSaved,
  type ResearchLabelNext,
  type ResearchMyLabel,
} from "@drift/shared";
import { Button } from "@drift/ui";
import { useTranslations } from "next-intl";
import { useEffect, useId, useState, type ReactNode } from "react";

import { ApiError } from "@/lib/api";

import { clock } from "../format";

import { useLabelNext, useResearchClassifiers, useSaveLabel } from "./api";
import { pctSigned, tone, usdSigned } from "./format";
import { usd4 } from "./trace-text";
import { Na } from "./ui";
import { classifierShort } from "./version-text";

// Nhãn phân loại (#306; thiết kế docs/mockups/signal-research/bot-versions-labels.html, API #304 / DEC-333): Right /
// Wrong trên thẻ Score, bảng chất lượng theo version classifier, "Label a random signal" (`labels/next`). Trong luồng
// gắn nhãn ngẫu nhiên, kết quả lệnh ẩn tới khi lưu (API chỉ trả kết quả trong response của lần lưu). Trace không ẩn
// kết quả lệnh (DEC-333). #348: luồng ngẫu nhiên gửi `labelToken` của `labels/next` ở lần lưu đầu (server mới tính nhãn
// là `random`, chỉ nhãn random tính cổng); bảng chất lượng hiện riêng số bài gắn từ trace ("from traces: n").

type Reason = ClassificationWrongReason;

/** Body của `PUT /articles/:id/label` từ form; null khi chưa đủ (chưa chọn Right / Wrong, Wrong mà chưa có lý do). */
export function labelBody(
  verdict: ClassificationVerdict | null,
  reason: Reason | "",
  note: string,
): { verdict: ClassificationVerdict; reason: Reason | null; note: string | null } | null {
  if (verdict === null) return null;
  if (verdict === "wrong" && reason === "") return null;
  const n = note.trim();
  return {
    verdict,
    reason: verdict === "wrong" && reason !== "" ? reason : null,
    note: n === "" ? null : n,
  };
}

/**
 * Hộp "Is this classification right?": Right / Wrong, lý do khi Wrong, ghi chú, Save label. `hidden` = luồng gắn nhãn
 * ngẫu nhiên (ghi câu "The trade result stays hidden until you save…"). `labelToken` (chỉ luồng ngẫu nhiên) đi kèm lần
 * lưu đầu; các lần sửa sau không gửi (server giữ `random` khi Right / Wrong không đổi).
 */
export function LabelForm({
  articleId,
  initial,
  hidden,
  tz,
  labelToken = null,
  onSaved,
}: {
  articleId: string;
  initial: ResearchMyLabel | null;
  hidden: boolean;
  tz: string;
  labelToken?: string | null;
  onSaved?: (r: ResearchLabelSaved) => void;
}) {
  const t = useTranslations("signalAnalysis.research.labeling");
  const tc = useTranslations("common.errors");
  const id = useId();
  const [verdict, setVerdict] = useState<ClassificationVerdict | null>(initial?.verdict ?? null);
  const [reason, setReason] = useState<Reason | "">(initial?.reason ?? "");
  const [note, setNote] = useState(initial?.note ?? "");
  const [saved, setSaved] = useState<ResearchMyLabel | null>(initial);
  const [err, setErr] = useState<string | null>(null);
  const save = useSaveLabel((r) => {
    setSaved(r.label);
    onSaved?.(r);
  });
  const body = labelBody(verdict, reason, note);
  const dirty = saved === null || body === null || !sameLabel(saved, body);
  return (
    <div className="flex flex-col gap-2.5 rounded-tile border border-border p-3.5">
      <span className="text-sm font-extrabold text-ink" id={`${id}-q`}>
        {t("question")}
      </span>
      <div role="group" aria-label={t("verdictGroup")} className="flex gap-2">
        {(["right", "wrong"] as const).map((v) => (
          <button
            key={v}
            type="button"
            aria-pressed={verdict === v}
            disabled={save.isPending}
            onClick={() => {
              setVerdict(v);
              setErr(null);
            }}
            className={`min-h-11 rounded-control border px-4 text-sm font-bold ${
              verdict === v
                ? v === "wrong"
                  ? "border-neg-border bg-neg-bg text-neg-ink"
                  : "border-pos bg-pos-bg text-pos"
                : "border-border-input bg-surface text-ink"
            }`}
          >
            {t(`verdict.${v}`)}
          </button>
        ))}
      </div>
      {verdict === "wrong" ? (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-r`} className="text-sm font-semibold text-ink">
            {t("whatWrong")}
          </label>
          <select
            id={`${id}-r`}
            value={reason}
            disabled={save.isPending}
            onChange={(e) => {
              setReason(e.target.value as Reason | "");
            }}
            className={input}
          >
            <option value="">{t("pickReason")}</option>
            {CLASSIFICATION_WRONG_REASONS.map((r) => (
              <option key={r} value={r}>
                {t(`reasons.${r}`)}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-n`} className="text-sm font-semibold text-ink">
          {t("note")}
        </label>
        <input
          id={`${id}-n`}
          type="text"
          maxLength={500}
          value={note}
          disabled={save.isPending}
          onChange={(e) => {
            setNote(e.target.value);
          }}
          className={input}
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <span className="text-xs text-muted">
          {hidden ? t("hidden") : saved === null ? t("rule") : null}
        </span>
        <Button
          pending={save.isPending}
          disabled={body === null || !dirty}
          onClick={() => {
            if (body === null) return;
            setErr(null);
            save.mutate(
              {
                articleId,
                body: saved === null && labelToken !== null ? { ...body, labelToken } : body,
              },
              {
                onError: (e) => {
                  setErr(
                    e instanceof ApiError &&
                      e.code === ErrorCode.stateConflict &&
                      e.details.reason === "NOT_A_SIGNAL"
                      ? t("notSignal")
                      : t("saveError"),
                  );
                },
              },
            );
          }}
        >
          {save.isPending ? t("saving") : t("save")}
        </Button>
      </div>
      {save.checking ? (
        <p role="status" className="m-0 text-xs font-semibold text-ink-2">
          {tc("unconfirmed")}
        </p>
      ) : err !== null ? (
        <p role="alert" className="m-0 text-xs font-semibold text-neg-ink">
          {err}
        </p>
      ) : null}
      {saved === null ? null : (
        <p role="status" className="m-0 text-xs text-muted">
          {t("saved", { who: saved.labeledBy, time: clock(saved.updatedAt, tz, false) })}
        </p>
      )}
    </div>
  );
}

function sameLabel(a: ResearchMyLabel, b: NonNullable<ReturnType<typeof labelBody>>): boolean {
  return a.verdict === b.verdict && a.reason === b.reason && a.note === b.note;
}

const input =
  "min-h-tap w-full rounded-control border border-border-input bg-surface px-3 text-sm text-ink disabled:cursor-not-allowed disabled:bg-surface-2";

/* ---------------------------------------------------------------- Classifier quality + random signal */

/** Id của tiêu đề khu chất lượng Claude reader (đích cuộn của "Label signals"). */
export const LABELS_ID = "sr-labels";

/**
 * "Is Claude reading news right?" (trước là Classifier quality) trong khu Bots & labels. `startSeq` tăng mỗi lần ai đó bấm
 * "Label signals" ở chỗ khác (dải tóm tắt, Is it working?): mở luồng gắn nhãn ngẫu nhiên. Đoạn giải thích dài nằm ở
 * drawer How it works › Labels.
 */
export function ClassifierQuality({ tz, startSeq = 0 }: { tz: string; startSeq?: number }) {
  const t = useTranslations("signalAnalysis.research.labeling");
  const tc = useTranslations("common.errors");
  const q = useResearchClassifiers();
  const [labelling, setLabelling] = useState(false);
  useEffect(() => {
    if (startSeq > 0) setLabelling(true);
  }, [startSeq]);
  const data = q.data;
  const cur = data?.items.find((r) => r.current) ?? null;
  return (
    <section aria-labelledby={LABELS_ID} className="flex min-w-0 flex-col gap-3.5">
      <h3 id={LABELS_ID} tabIndex={-1} className="m-0 scroll-mt-4 text-[17px] font-extrabold">
        {t("title")}
      </h3>
      <div className="flex flex-wrap items-start gap-4">
        {labelling ? (
          <div className="flex min-w-0 flex-[3_1_480px] flex-col gap-3">
            <LabelFlow
              tz={tz}
              onClose={() => {
                setLabelling(false);
              }}
            />
          </div>
        ) : null}
        <div className="flex min-w-0 flex-[2_1_340px] flex-col gap-3">
          {data === undefined ? (
            q.isError ? (
              <p
                role="alert"
                className="m-0 flex flex-wrap items-center gap-3 text-sm text-neg-ink"
              >
                {t("error")}
                <Button variant="secondary" onClick={() => void q.refetch()}>
                  {tc("retry")}
                </Button>
              </p>
            ) : (
              <p className="m-0 text-sm text-muted">{t("loading")}</p>
            )
          ) : data.items.length === 0 ? (
            <p className="m-0 text-sm text-muted">{t("none")}</p>
          ) : (
            <>
              <QualityTable rows={data.items} />
              <p className="m-0 rounded-tile bg-surface-2 p-3.5 text-[13px] leading-normal text-ink-2">
                {cur?.interval != null && cur.precisionPct !== null
                  ? t.rich("floorRange", {
                      min: data.gate.minLabels,
                      pct: data.gate.minPrecisionPct,
                      n: cur.labeled,
                      p: Math.round(cur.precisionPct),
                      lo: Math.round(cur.interval.lo),
                      hi: Math.round(cur.interval.hi),
                      b: (c: ReactNode) => <b className="text-ink">{c}</b>,
                    })
                  : t.rich("floor", {
                      min: data.gate.minLabels,
                      pct: data.gate.minPrecisionPct,
                      b: (c: ReactNode) => <b className="text-ink">{c}</b>,
                    })}
              </p>
              {cur === null ? null : <Mistakes row={cur} />}
            </>
          )}
          <Button
            variant="secondary"
            onClick={() => {
              setLabelling(true);
            }}
          >
            {t("random")}
          </Button>
        </div>
      </div>
    </section>
  );
}

function QualityTable({ rows }: { rows: readonly ResearchClassifierRow[] }) {
  const t = useTranslations("signalAnalysis.research.labeling");
  const th = "border-b border-border px-2 py-2 text-left text-xs font-bold text-muted";
  const td = "border-b border-bg px-2 py-2.5 text-left align-top text-sm";
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <caption className="sr-only">{t("table")}</caption>
        <thead>
          <tr>
            {(["classifier", "labels", "right", "counts"] as const).map((k) => (
              <th key={k} scope="col" className={th}>
                {t(`cols.${k}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const v = classifierShort(r.classifierVersion);
            return (
              <tr key={r.classifierVersion}>
                <th scope="row" className={`${td} font-bold`}>
                  {r.current ? t("current", { v }) : v}
                </th>
                <td className={td}>
                  {r.labeled}
                  {r.traceLabeled > 0 ? (
                    <span className="block text-xs text-muted">
                      {t("fromTraces", { n: r.traceLabeled })}
                    </span>
                  ) : null}
                </td>
                <td className={td}>
                  {r.precisionPct === null ? (
                    <Na />
                  ) : (
                    <>
                      {`${String(Math.round(r.precisionPct))}%`}
                      {r.interval === null ? null : (
                        <span className="block text-xs text-muted">
                          {t("range", {
                            lo: Math.round(r.interval.lo),
                            hi: Math.round(r.interval.hi),
                          })}
                        </span>
                      )}
                    </>
                  )}
                </td>
                <td
                  className={`${td} font-bold ${
                    r.status === "passed"
                      ? "text-pos"
                      : r.status === "underPrecision"
                        ? "text-neg-ink"
                        : "text-warn"
                  }`}
                >
                  {r.status === "needsLabels"
                    ? t("counts.needsLabels", { k: r.labelsToGo })
                    : t(`counts.${r.status}`, { n: r.labeled })}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Mistakes({ row }: { row: ResearchClassifierRow }) {
  const t = useTranslations("signalAnalysis.research.labeling");
  return (
    <div className="flex flex-col gap-1">
      <h3 className="m-0 text-[15px] font-extrabold">
        {t("mistakes", { v: classifierShort(row.classifierVersion) })}
      </h3>
      {row.mostCommonMistakes.length === 0 ? (
        <p className="m-0 text-sm text-muted">{t("noMistakes")}</p>
      ) : (
        <ul className="m-0 pl-5 text-sm text-ink-2">
          {row.mostCommonMistakes.map((m) => (
            <li key={m.reason}>
              {t(`reasonsShort.${m.reason}`)} · {m.n}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** "Label a random signal": bài từ `labels/next`, kết quả lệnh ẩn tới khi lưu (chỉ có trong response của lần lưu). */
function LabelFlow({ tz, onClose }: { tz: string; onClose: () => void }) {
  const t = useTranslations("signalAnalysis.research.labeling");
  const q = useLabelNext(true);
  const [saved, setSaved] = useState<ResearchLabelSaved | null>(null);
  const next = () => {
    setSaved(null);
    void q.refetch();
  };
  if (q.isPending || q.isFetching) return <p className="m-0 text-sm text-muted">{t("loading")}</p>;
  if (q.isError)
    return (
      <p role="alert" className="m-0 flex flex-wrap items-center gap-3 text-sm text-neg-ink">
        {t("nextError")}
        <Button variant="secondary" onClick={next}>
          {t("next")}
        </Button>
      </p>
    );
  const data: ResearchLabelNext = q.data;
  const item = data.item;
  return (
    <div className="flex flex-col gap-3">
      {item === null ? (
        <p className="m-0 text-sm text-muted">{t("empty")}</p>
      ) : (
        <article
          aria-label={t("claudeSaid")}
          className="flex flex-col gap-3 rounded-tile border border-border p-3.5"
        >
          <span className="text-xs text-muted">
            {t("remaining", {
              n: data.remaining,
              v: classifierShort(item.classification.classifierVersion),
            })}
          </span>
          <ClaudeSaid item={item} />
          <LabelForm
            key={item.article.id}
            articleId={item.article.id}
            initial={null}
            hidden={saved === null}
            tz={tz}
            labelToken={data.labelToken}
            onSaved={setSaved}
          />
          <div className="flex flex-col gap-1.5 rounded-tile border border-border p-3.5">
            <h3 className="m-0 text-[15px] font-extrabold">{t("decide")}</h3>
            {saved === null ? (
              <p className="m-0 text-sm text-muted">{t("resultHidden")}</p>
            ) : (
              <SavedTrades trades={saved.trades} />
            )}
          </div>
        </article>
      )}
      <div className="flex flex-wrap gap-2">
        {item === null || saved !== null ? (
          <Button onClick={next} disabled={item === null && data.remaining === 0}>
            {t("next")}
          </Button>
        ) : null}
        <Button variant="secondary" onClick={onClose}>
          {t("close")}
        </Button>
      </div>
    </div>
  );
}

function ClaudeSaid({ item }: { item: NonNullable<ResearchLabelNext["item"]> }) {
  const t = useTranslations("signalAnalysis.research.labeling");
  const tn = useTranslations("signalAnalysis.research");
  const c = item.classification;
  const a = item.article;
  const cost = c.claude?.costUsd ?? null;
  const b = (x: ReactNode) => <b className="text-ink">{x}</b>;
  return (
    <div className="flex flex-col gap-1 rounded-tile bg-surface-2 p-3.5 text-sm">
      <span className="text-xs font-bold text-muted">{t("article")}</span>
      {a.url === null ? (
        <b className="text-ink">{a.title ?? a.content ?? tn("na")}</b>
      ) : (
        <a href={a.url} target="_blank" rel="noreferrer" className="font-bold text-ink">
          {a.title ?? a.content ?? tn("na")}
        </a>
      )}
      {a.title !== null && a.content !== null ? (
        <p className="m-0 line-clamp-4 text-[13px] text-ink-2">{a.content}</p>
      ) : null}
      <span className="mt-1.5 text-xs font-bold text-muted">{t("claudeSaid")}</span>
      <span className="text-ink-2">
        {t.rich("said", {
          type: tn(`trades.newsTypes.${c.newsType}`),
          asset: c.asset ?? tn("na"),
          relevance: c.relevance === null ? tn("na") : t(`relevance.${c.relevance}`),
          promo:
            c.promotional === null ? t("promo.na") : c.promotional ? t("promo.yes") : t("promo.no"),
          b,
        })}
      </span>
      <span className="text-xs text-muted">
        {cost === null
          ? t("metaNoCost", { v: classifierShort(c.classifierVersion) })
          : t("meta", { v: classifierShort(c.classifierVersion), cost: usd4(cost) })}
      </span>
    </div>
  );
}

function SavedTrades({ trades }: { trades: ResearchLabelSaved["trades"] }) {
  const t = useTranslations("signalAnalysis.research.labeling");
  const tn = useTranslations("signalAnalysis.research");
  if (trades.length === 0) return <p className="m-0 text-sm text-muted">{t("noTrades")}</p>;
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm">
      {trades.map((x) => {
        const side = tn(`sides.${x.side}`);
        if (x.status === "open") return <li key={x.tradeId}>{t("tradeOpen", { side })}</li>;
        const result =
          x.resultPct === null || x.resultUsdc === null ? (
            tn("na")
          ) : (
            <span className={`font-bold ${tone(x.resultPct)}`}>
              {`${pctSigned(x.resultPct)} (${usdSigned(x.resultUsdc)})`}
            </span>
          );
        return (
          <li key={x.tradeId}>
            {t("trade", { side, outcome: tn(`trades.resultShort.${x.outcome}`) })}
            {tn("trades.sep")}
            {result}
          </li>
        );
      })}
    </ul>
  );
}
