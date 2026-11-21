"use client";

import type { DecisionOutcome } from "@drift/shared";
import {
  DecisionsList as DecisionsListView,
  type DecisionChildRow,
  type DecisionListRow,
  type DecisionResult,
  type DecisionTone,
} from "@drift/ui";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { formatAmount, formatDateTime } from "@/lib/format";

import {
  entryDuration,
  entryTryOf,
  groupDecisions,
  groupSummary,
  orderHref,
  orderTail,
  outcomeStatusKey,
  type BotEvent,
  type DecisionRow,
} from "../decision-groups";

// Trading Agent › Decisions & actions (BD-02, docs/mockups/bd02-decisions Main + Mobile): quyết định lặp lại được gộp
// thành một dòng mở ra được; mọi pill kết quả link tới lệnh theo clOrdID trong Execution & Orders. Các lần thử vào lệnh
// của một lượt Volume Farm gộp thành "Enter long · 8 tries in 2 min · Filled at …" (DEC-307). Bố cục, mở / thu nhóm và
// "Show all" nằm ở `DecisionsList` của `@drift/ui` (không chứa câu chữ, có story, #227); ở đây chỉ gộp event và dựng câu
// chữ từ i18n.

type GroupRow = Exclude<DecisionRow, { kind: "single" }>;

const clock = (v: string) => formatDateTime(v).split(", ").at(-1) ?? "";

function tone(o: DecisionOutcome): DecisionTone {
  if (o === "filled" || o === "partly_filled") return "positive";
  if (o === "open") return "accent";
  if (o === "unknown") return "unknown";
  if (o === "rejected") return "negative";
  return "neutral";
}

/** Câu chữ của dòng lượt vào lệnh: "8 tries in 2 min", kết quả của lần thử mới nhất, nhãn từng lần thử. */
function useEntryCopy(priceDigits: number | null) {
  const t = useTranslations("agent.decisionsList.entry");
  // Giá khớp trung bình làm tròn theo tick của market, như trang Orders.
  const price = (e: BotEvent) =>
    e.fillPrice === null ? null : (formatAmount(e.fillPrice, priceDigits)?.text ?? e.fillPrice);
  /** Kết quả theo lệnh thật của một lần thử; giá chỉ khi API có giá khớp (không đoán, quy tắc 1.8). */
  const result = (e: BotEvent): string => {
    const p = price(e);
    if (e.outcome === "filled") return p === null ? t("filled") : t("filledAt", { price: p });
    if (e.outcome === "partly_filled")
      return p === null ? t("partlyFilled") : t("partlyFilledAt", { price: p });
    if (e.outcome === "open") return t("onBook");
    if (e.outcome === "rejected") return t("postOnlyMiss");
    if (e.outcome === "not_placed") return t("notPlaced");
    return t("cancelled");
  };
  return {
    tries: (r: GroupRow) => {
      const d = entryDuration(r.events);
      const duration = d.unit === "hours" ? t("hours", { h: d.h, m: d.m }) : t(d.unit, { n: d.n });
      // Nhóm không bắt đầu ở lần thử đầu của lượt (bị cắt bởi giới hạn 50 event hoặc bị tách): chỉ nói khoảng lần thử đang
      // thấy, không nói tổng số lần thử của lượt (review #215 B2).
      const oldest = r.events.at(-1);
      const newest = r.events[0];
      const from = oldest === undefined ? null : entryTryOf(oldest);
      const to = newest === undefined ? null : entryTryOf(newest);
      return from === null || to === null || from === 0
        ? t("tries", { n: r.events.length, duration })
        : t("triesRange", { from: from + 1, to: to + 1, duration });
    },
    /** Dòng tổng của lượt: lần thử mới nhất đã khớp / đang nằm sổ, hoặc chưa khớp. */
    head: (r: GroupRow): string => {
      const last = r.events[0];
      if (last === undefined) return "";
      return last.outcome === "filled" ||
        last.outcome === "partly_filled" ||
        last.outcome === "open"
        ? result(last)
        : t("notFilled");
    },
    child: (e: BotEvent): string => `${t("try", { n: (entryTryOf(e) ?? 0) + 1 })} · ${result(e)}`,
  };
}

export function DecisionsList({
  botId,
  events,
  why,
  ask,
  legacy,
  priceDigits = null,
}: {
  botId: string;
  /** Mới nhất trước, như API trả. */
  events: readonly BotEvent[];
  why: (e: BotEvent) => string | null;
  /** Nút "Ask about this" cạnh tên quyết định (không có ở bot paper). */
  ask?: (e: BotEvent, time: string) => ReactNode;
  /** Pill cho cột `result` dạng chữ cũ (event chưa gắn lệnh). */
  legacy: (text: string) => ReactNode;
  /** Chữ số thập phân của giá theo tick của market của bot (giá khớp của lượt vào lệnh); null = chưa biết. */
  priceDigits?: number | null;
}) {
  const t = useTranslations("agent");
  const tl = useTranslations("agent.decisionsList");
  const ts = useTranslations("orders.status");
  const tsum = useTranslations("agent.decisionsList.summary");
  const entry = useEntryCopy(priceDigits);

  /** Pill kết quả: link tới lệnh khi có clOrdID, nhãn lấy từ `orders.status.*`. */
  const result = (e: BotEvent): DecisionResult => {
    if (e.outcome === null) return e.result === null ? null : { node: legacy(e.result) };
    const label = ts(outcomeStatusKey(e.outcome));
    if (e.order === null) return { pill: { label, tone: tone(e.outcome) } };
    return {
      pill: {
        label,
        tone: tone(e.outcome),
        href: orderHref(botId, e, e.order),
        linkLabel: tl("showOrder", { result: label, tail: orderTail(e.order) }),
      },
    };
  };

  const rows: DecisionListRow[] = groupDecisions(events).map((r): DecisionListRow => {
    if (r.kind === "single") {
      const e = r.event;
      const time = formatDateTime(e.occurredAt);
      const shortTime = clock(e.occurredAt).slice(0, 5);
      const action = ask?.(e, time);
      const mobileAction = ask?.(e, shortTime);
      return {
        kind: "single",
        id: e.id,
        time,
        shortTime,
        name: e.decision ?? e.type,
        why: why(e),
        result: result(e),
        ...(action === undefined ? {} : { action }),
        ...(mobileAction === undefined ? {} : { mobileAction }),
      };
    }
    const newest = r.events[0];
    const isEntry = r.kind === "entry";
    const children: DecisionChildRow[] = r.events.map((c) => ({
      id: c.id,
      time: clock(c.occurredAt),
      label: isEntry ? entry.child(c) : r.name,
      why: why(c) ?? "",
      mobileText: isEntry ? entry.child(c) : (why(c) ?? ""),
      result: result(c),
    }));
    return {
      kind: "group",
      key: r.key,
      name: r.name,
      /** Nhãn cạnh tên nhóm: "×7" (BD-02) hoặc "8 tries in 2 min" (lượt vào lệnh). */
      badge: isEntry ? entry.tries(r) : tl("count", { n: r.events.length }),
      range: tl("range", {
        from: clock(r.events.at(-1)?.occurredAt ?? ""),
        to: clock(newest?.occurredAt ?? ""),
      }),
      shortTime: clock(r.events.at(-1)?.occurredAt ?? "").slice(0, 5),
      head: isEntry ? entry.head(r) : newest === undefined ? "" : (why(newest) ?? ""),
      mobileHead: isEntry ? entry.head(r) : null,
      summary: groupSummary(r.events).map(({ outcome, n }) => ({
        label: tsum(outcomeStatusKey(outcome), { n }),
        tone: tone(outcome),
      })),
      panelLabel: tl("groupPanel", { n: r.events.length, name: r.name }),
      showAllLabel: tl("showAll", { n: r.events.length }),
      children,
    };
  });

  return (
    <DecisionsListView
      rows={rows}
      labels={{
        cols: {
          time: t("cols.time"),
          decision: t("cols.decision"),
          why: t("cols.why"),
          result: t("cols.result"),
        },
        list: t("decisions"),
        mobileList: t("recentDecisions"),
        emptyTitle: t("noDecisions"),
        emptyBody: tl("emptyBody"),
      }}
      renderLink={({ children, ...props }) => <Link {...props}>{children}</Link>}
    />
  );
}
