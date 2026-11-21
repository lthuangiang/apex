import {
  AssetMode,
  CLASSIFIER_GATE,
  NEWS_RULES,
  READER_NEW_BADGE,
  SIGNAL_CATALYSTS,
  type BotVersionConfig,
  type ResearchClassifierRow,
  type ResearchNewsType,
  type ResearchVersion,
  type ResearchVersionChange,
  type SignalCatalyst,
} from "@drift/shared";
import type { useTranslations } from "next-intl";

import { count, monthDay, clock } from "../format";

import { hold } from "./format";

// Câu chữ của News bot versions (#306; thiết kế docs/mockups/signal-research/bot-versions*.html). Hàm thuần: chỉ ghép số
// API đã trả (DEC-337), không tự tính số nào ngoài phép đếm / so sánh hiển thị.

export type Tv = ReturnType<typeof useTranslations<"signalAnalysis.research.versions">>;
export type Tn = ReturnType<typeof useTranslations<"signalAnalysis.research">>;

/** Khoá config (`etf_approved`…) → khoá loại tin của API, để dùng lại tên ở `research.trades.newsTypes`. */
export const CATALYST_TYPE: Record<SignalCatalyst, ResearchNewsType> = {
  hack_exploit: "hack",
  listing: "listing",
  delisting: "delisting",
  etf_approved: "etfApproved",
  etf_delayed_or_rejected: "etfDelayed",
  regulatory_action: "regulatorAgainst",
  favorable_ruling: "regulatorFavour",
  treasury_buy: "treasuryBuy",
  treasury_sell: "treasurySell",
  earnings_beat: "earningsBeat",
  earnings_miss: "earningsMiss",
  token_unlock: "unlock",
};

export const catalystName = (c: SignalCatalyst, t: Tn): string =>
  t(`trades.newsTypes.${CATALYST_TYPE[c]}`);

/** "news-classifier-v2" → "v2" (thẻ và bảng của thiết kế); tên khác giữ nguyên. */
export function classifierShort(v: string): string {
  return /-(v\d+)$/.exec(v)?.[1] ?? v;
}

const DAY_MS = 86_400_000;

/**
 * #395: nhãn "New in v4" còn hiện không: reader `READER_NEW_BADGE.classifierVersion` chưa chạy đủ `days` ngày tính từ
 * `startedAt` của API (chưa có started_at = chưa chạy = vẫn mới). Chưa có danh sách classifier (đang tải / lỗi) hoặc danh
 * sách không có reader đó → không hiện.
 */
export function readerBadgeShown(
  items: readonly Pick<ResearchClassifierRow, "classifierVersion" | "startedAt">[] | undefined,
  now: number,
): boolean {
  const row = items?.find((r) => r.classifierVersion === READER_NEW_BADGE.classifierVersion);
  if (row === undefined) return false;
  if (row.startedAt === null) return true;
  return now - Date.parse(row.startedAt) < READER_NEW_BADGE.days * DAY_MS;
}

/**
 * #395: reader vừa bị thay (thẻ "Claude reader v3 · Retired {date}"): classifier ngay trước classifier hiện tại (API xếp
 * hiện tại trước rồi mới nhất trước), ngày retired = `startedAt` của classifier hiện tại. null khi chưa có reader cũ hoặc
 * không biết lúc reader hiện tại bắt đầu (không bao giờ đoán ngày).
 */
export function retiredReader(items: readonly ResearchClassifierRow[] | undefined): {
  row: ResearchClassifierRow;
  current: ResearchClassifierRow;
  retiredAt: string;
} | null {
  const current = items?.find((r) => r.current);
  const row = items?.find((r) => !r.current);
  if (current === undefined || row === undefined || current.startedAt === null) return null;
  return { row, current, retiredAt: current.startedAt };
}

/** Bội số như người lưu đã nhập ("1.5", "0.75", "1.0" như thiết kế "SL 0.75× → 1.0×"). */
export const multiple = (v: string): string => v;

export const versionTitle = (v: Pick<ResearchVersion, "number" | "name">, t: Tv): string =>
  t("cardTitle", { n: v.number, name: v.name });
export const versionShort = (v: Pick<ResearchVersion, "number" | "name">, t: Tv): string =>
  t("short", { n: v.number, name: v.name });

export function savedLine(v: ResearchVersion, tz: string, t: Tv): string {
  const at = { date: monthDay(v.createdAt, tz), time: clock(v.createdAt, tz, false) };
  if (v.isBaseline) return t("savedBaseline", at);
  return v.createdBy === null ? t("saved", at) : t("savedBy", { ...at, who: v.createdBy });
}

const enabledTypes = (cfg: BotVersionConfig) =>
  SIGNAL_CATALYSTS.filter((c) => cfg.news[c]?.enabled === true);

/** "All 12 news types · level Low and up · 500 USDC · TP 1.5× · SL 0.75× · classifier v2". */
export function configLine(v: ResearchVersion, t: Tv): string {
  const cfg = v.config;
  if (cfg === null) return t("summary.unreadable");
  const on = enabledTypes(cfg).length;
  const parts = [
    on === SIGNAL_CATALYSTS.length
      ? t("summary.allTypes", { n: on })
      : t("summary.types", { n: on }),
    t("summary.level", { level: cfg.minLevel }),
    t("summary.size", { size: count(Number(cfg.sizeUsdc)) }),
    t("summary.tp", { x: multiple(cfg.tpMultiple) }),
    t("summary.sl", { x: multiple(cfg.slMultiple) }),
  ];
  const list = cfg.assets.markets.join(", ");
  if (cfg.assets.mode === AssetMode.only) parts.push(t("summary.only", { list }));
  else {
    if (!cfg.assets.stocks) parts.push(t("summary.cryptoOnly"));
    else if (!cfg.assets.crypto) parts.push(t("summary.stocksOnly"));
    if (cfg.assets.mode === AssetMode.except && list !== "")
      parts.push(t("summary.except", { list }));
  }
  const cur = classifierShort(v.classifier.current);
  const changed = v.classifier.used.some((u) => u !== v.classifier.current);
  parts.push(
    changed ? t("summary.classifierNow", { v: cur }) : t("summary.classifier", { v: cur }),
  );
  return parts.join(" · ");
}

/** Cột Classifier của bảng: các classifier đã tạo lệnh thật ("v1 → v2"); null khi chưa có lệnh. */
export function classifiersUsed(v: ResearchVersion): string | null {
  return v.classifier.used.length === 0 ? null : v.classifier.used.map(classifierShort).join(" → ");
}

type Labels = ReadonlyMap<string, ResearchClassifierRow>;

/**
 * Trạng thái cổng ngắn (cột Gate, ô "Count for the gate" khi chờ nhãn). `not_counted` nói classifier nào và vì sao, luôn
 * kèm số nhãn khi biết (PM chốt ở review #313): "Not counted · classifier v1 under 80% · 24 labels".
 */
export function gateText(v: ResearchVersion, labels: Labels, t: Tv): string {
  const g = v.gate;
  switch (g.status) {
    case "collecting":
      return v.status === "stopped" || v.status === "retired"
        ? t("gate.stoppedEarly")
        : t("gate.collecting");
    case "waits_for_labels":
    case "passes":
    case "fails":
      return t(`gate.${g.status}`);
    case "needs_repeat":
      return g.repeat === null
        ? t("gate.collecting")
        : t("gate.needs_repeat", { closed: g.repeat.closed, needed: g.repeat.needed });
    case "not_counted":
      return notCountedText(v, labels, t);
  }
}

function notCountedText(v: ResearchVersion, labels: Labels, t: Tv): string {
  const g = v.gate;
  // Classifier hiện tại chưa qua (dưới 80% hoặc không biết): lý do là chính nó.
  if (g.classifierStatus === "underPrecision") return under(v.classifier.current, labels, t);
  if (g.classifierStatus !== "needsLabels") return t("gate.notCounted");
  // Classifier hiện tại chờ nhãn và chưa có lệnh đóng nào của nó: lý do là classifier cũ có nhiều lệnh nhất.
  const old = [...g.notCounted]
    .filter((x) => x.classifierVersion !== v.classifier.current)
    .sort((a, b) => b.closed - a.closed)[0];
  if (old === undefined || old.classifierVersion === null) return t("gate.notCounted");
  if (old.status === "underPrecision") return under(old.classifierVersion, labels, t);
  if (old.status === "needsLabels" && old.labelsToGo !== null)
    return t("gate.notCountedWaits", {
      v: classifierShort(old.classifierVersion),
      n: old.labelsToGo,
    });
  return t("gate.notCounted");
}

/** "Not counted · classifier v1 under 80% · 24 labels" (không có số nhãn khi API classifiers chưa trả dòng đó). */
function under(classifier: string, labels: Labels, t: Tv): string {
  const row = labels.get(classifier);
  const v = classifierShort(classifier);
  return row === undefined
    ? t("gate.notCountedUnder", { v })
    : t("gate.notCountedUnderN", { v, n: row.labeled });
}

/**
 * Câu giải thích dưới số của thẻ (chữ màu cảnh báo): lệnh của classifier cũ không được tính, classifier hiện tại chờ
 * nhãn / dưới 80%, hoặc tiến độ lặp lại của kiểm tra thêm. Rỗng khi không có gì cần nói.
 */
export function gateLines(v: ResearchVersion, labels: Labels, tz: string, t: Tv): string[] {
  const g = v.gate;
  const cur = v.classifier.current;
  const out: string[] = [];
  for (const x of g.notCounted) {
    if (x.classifierVersion === cur) continue;
    if (x.classifierVersion === null || x.status === "unknown")
      out.push(t("line.oldUnknown", { n: x.closed }));
    else if (x.status === "underPrecision")
      out.push(t("line.oldUnder", { n: x.closed, v: classifierShort(x.classifierVersion) }));
    else
      out.push(
        t("line.oldWaits", {
          n: x.closed,
          v: classifierShort(x.classifierVersion),
          k: x.labelsToGo ?? 0,
        }),
      );
  }
  const short = classifierShort(cur);
  if (g.classifierStatus === "needsLabels") {
    const startedLater = Date.parse(v.classifier.segmentStart) > Date.parse(v.createdAt);
    out.push(
      startedLater
        ? t("line.newCount", {
            v: short,
            date: monthDay(v.classifier.segmentStart, tz),
            time: clock(v.classifier.segmentStart, tz, false),
            k: g.labelsToGo,
          })
        : t("line.waits", {
            v: short,
            min: CLASSIFIER_GATE.minLabels,
            pct: CLASSIFIER_GATE.minPrecisionPct,
            k: g.labelsToGo,
          }),
    );
  } else if (g.classifierStatus === "underPrecision") {
    const row = labels.get(cur);
    out.push(
      row === undefined
        ? `${t("gate.notCountedUnder", { v: short })}.`
        : t("line.under", { v: short, n: row.labeled }),
    );
  } else if (g.status === "needs_repeat" && g.firstPassAt !== null && g.repeat !== null)
    out.push(
      t("line.repeat", {
        first: g.firstPassAt,
        needed: g.repeat.needed,
        closed: g.repeat.closed,
      }),
    );
  return out;
}

/** Một điểm khác với version đã chép từ, thành câu ("SL 0.75× → 1.0×"). `to` = config của version mới (danh sách đủ). */
export function changeText(
  c: ResearchVersionChange,
  to: BotVersionConfig | null,
  t: Tv,
  tn: Tn,
): string {
  const lvl = (l: "high" | "medium" | "low") => tn(`levels.${l}`);
  const perDay = (n: number | null) => (n === null ? t("change.off") : String(n));
  const kinds = (k: { crypto: boolean; stocks: boolean }) =>
    t("change.kinds", { crypto: String(k.crypto), stocks: String(k.stocks) });
  switch (c.field) {
    case "newsType": {
      const type = catalystName(c.catalyst, tn);
      const on = (x: typeof c.from) => x?.enabled === true;
      if (!on(c.to)) return t("change.newsTypeOff", { type });
      if (!on(c.from)) return t("change.newsTypeOn", { type });
      return t("change.newsTypeHold", {
        type,
        from: hold(c.from?.maxHoldHours ?? 0),
        to: hold(c.to?.maxHoldHours ?? 0),
      });
    }
    case "minLevel":
      return t("change.minLevel", { from: lvl(c.from), to: lvl(c.to) });
    case "maxSourceDelayMinutes":
    case "maxOpenTrades":
      return t(`change.${c.field}`, { from: c.from, to: c.to });
    case "maxNewTradesPerDay":
      return t("change.maxNewTradesPerDay", { from: perDay(c.from), to: perDay(c.to) });
    case "sizeUsdc":
      return t("change.sizeUsdc", { from: count(Number(c.from)), to: count(Number(c.to)) });
    case "tpMultiple":
    case "slMultiple":
    case "minTpCostMultiple":
      return t(`change.${c.field}`, { from: multiple(c.from), to: multiple(c.to) });
    case "onOppositeNews":
      return t("change.onOppositeNews", {
        from: t(`change.policy.${c.from}`),
        to: t(`change.policy.${c.to}`),
      });
    case "assetMode":
      return t("change.assetMode", {
        from: t(`sheet.modes.${c.from}`),
        to: t(`sheet.modes.${c.to}`),
      });
    case "assetKinds":
      return t("change.assetKinds", { from: kinds(c.from), to: kinds(c.to) });
    case "assets": {
      // Như thiết kế: danh sách đủ của version mới ("Only BTC-USD, ETH-USD, SOL-USD").
      if (to !== null && to.assets.mode !== AssetMode.all && to.assets.markets.length > 0) {
        const list = to.assets.markets.join(", ");
        return to.assets.mode === AssetMode.only
          ? t("change.assetsOnly", { list })
          : t("change.assetsExcept", { list });
      }
      const parts: string[] = [];
      if (c.added.length > 0) parts.push(t("change.assetsAdded", { list: c.added.join(", ") }));
      if (c.removed.length > 0)
        parts.push(t("change.assetsRemoved", { list: c.removed.join(", ") }));
      return parts.join(" · ");
    }
  }
}

/** Ô "Changed from the one before" của bảng All versions. */
export function changedCell(v: ResearchVersion, t: Tv, tn: Tn): string {
  if (v.changedFromPrevious === null) return t("notCopied");
  if (v.changedFromPrevious.length === 0) return t("noChanges");
  return v.changedFromPrevious.map((c) => changeText(c, v.config, t, tn)).join(" · ");
}

/** Chiều theo loại tin (không đảo được ở version, DEC-328). */
export const catalystSide = (c: SignalCatalyst) => NEWS_RULES.catalysts[c].direction;

/** Treasury không bao giờ giao dịch trên BTC / ETH (rules v3, #298). */
export const isTreasury = (c: SignalCatalyst) => c === "treasury_buy" || c === "treasury_sell";

/** Max open trades có hiệu lực ("Effectively N"): chỉ khi nhỏ hơn giới hạn đã đặt. */
export function effectiveNote(v: ResearchVersion): number | null {
  return v.effectiveMaxOpen !== null &&
    v.maxOpenTrades !== null &&
    v.effectiveMaxOpen < v.maxOpenTrades
    ? v.effectiveMaxOpen
    : null;
}
