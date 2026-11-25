"use client";

import type { BotDetail } from "@drift/shared";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { formatAmount, formatMoney } from "@/lib/format";

// #527 (artboard Agent, bản phác 25/11, docs/mockups/agent-position-hold): hai dòng nhỏ dưới ô Open orders (vị thế theo
// sổ của bot + lãi chưa chốt) và dưới ô Last decision (thời gian giữ của lượt Volume Builder). Chỉ hiện số backend trả về;
// thiếu giá thì "Not available", không bao giờ 0 (quy tắc 1.8).

const SUB = "block text-xs font-semibold leading-snug whitespace-normal";

const price = (v: string, digits: number | null) => formatAmount(v, digits)?.text ?? v;

/** Hai dòng dưới số lệnh đang mở. Null khi ô giữ như cũ (`positionShown` false). */
export function PositionLines({
  d,
  priceDigits,
}: {
  d: Pick<BotDetail, "positionShown" | "position" | "pendingOrder" | "openOrders">;
  priceDigits: number | null;
}) {
  const t = useTranslations("agent.position");
  const tm = useTranslations("common.missing");
  if (!d.positionShown) return null;
  const p = d.position;
  if (p !== null) {
    const pnl = p.unrealizedPnl;
    const tone =
      pnl === null || Number(pnl) === 0 ? "text-ink-2" : Number(pnl) > 0 ? "text-pos" : "text-neg";
    return (
      <>
        <span className={`${SUB} text-ink-2`}>
          <span className={p.side === "long" ? "text-pos" : "text-neg"}>{t(p.side)}</span>{" "}
          {t("at", {
            size: formatMoney(p.value) ?? p.value,
            price: price(p.avgEntry, priceDigits),
          })}
        </span>
        <span className={`${SUB} ${tone}`}>
          {pnl === null
            ? tm("notAvailable")
            : t("unrealized", { value: (formatMoney(pnl, true) ?? pnl).replace("−", "-") })}
        </span>
      </>
    );
  }
  if (d.openOrders === 0) return <span className={`${SUB} text-ink-2`}>{t("noOpenPosition")}</span>;
  const o = d.pendingOrder;
  return (
    <>
      {o === null ? null : (
        <span className={`${SUB} text-ink-2`}>
          {t(o.side === "buy" ? "buyAt" : "sellAt", {
            size: formatMoney(o.value) ?? o.value,
            price: price(o.price, priceDigits),
          })}
        </span>
      )}
      <span className={`${SUB} text-muted`}>{t("noPositionYet")}</span>
    </>
  );
}

type HoldState = "starts" | "counting" | "finished" | "plain" | "none";

/** Trạng thái thời gian giữ theo giờ server ước tính (`now`). Thoát sớm trước `holdUntil` thì không hiện gì. */
export function holdState(hold: NonNullable<BotDetail["hold"]>, now: number): HoldState {
  if (hold.openedAt === null) return hold.phase === "entering" ? "starts" : "plain";
  if (hold.holdUntil === null) return "plain";
  if (now < Date.parse(hold.holdUntil)) return hold.phase === "exiting" ? "none" : "counting";
  return "finished";
}

/**
 * Hai dòng dưới giờ của decision (chỉ Volume Builder). Đồng hồ chạy trên trình duyệt từ mốc backend gửi, bù lệch giờ
 * máy bằng `serverTime` lúc nhận dữ liệu; mỗi lần tải lại dữ liệu thì đồng bộ lại. Số đếm KHÔNG nằm trong vùng
 * `aria-live` (không đọc lại mỗi giây); chỉ câu trạng thái (không có số giây) được đọc một lần khi đổi.
 */
export function HoldLines({
  hold,
  serverTime,
  receivedAt,
}: {
  hold: BotDetail["hold"];
  serverTime: string;
  receivedAt: number;
}) {
  const t = useTranslations("agent.hold");
  const offset = Date.parse(serverTime) - receivedAt;
  const [now, setNow] = useState(() => Date.now() + offset);
  const until = hold?.holdUntil ?? null;
  useEffect(() => {
    setNow(Date.now() + offset);
    if (until === null) return;
    const timer = setInterval(() => {
      setNow(Date.now() + offset);
    }, 1_000);
    return () => {
      clearInterval(timer);
    };
  }, [offset, until]);
  if (hold === null) return null;
  const state = holdState(hold, now);
  if (state === "none") return null;
  const left = until === null ? 0 : Math.max(0, Math.ceil((Date.parse(until) - now) / 1_000));
  const announce =
    state === "starts" ? t("startsWhenFilled") : state === "finished" ? t("finished") : "";
  return (
    <>
      <span className={`${SUB} text-ink-2`}>{t("holdN", { n: hold.holdSecs })}</span>
      {state === "starts" ? (
        <span aria-hidden="true" className={`${SUB} text-muted`}>
          {t("startsWhenFilled")}
        </span>
      ) : state === "counting" ? (
        <span className={`${SUB} text-accent-ink tabular-nums`} data-testid="hold-left">
          {t("left", { n: left })}
        </span>
      ) : state === "finished" ? (
        <span aria-hidden="true" className={`${SUB} text-warn`}>
          {t("finished")}
        </span>
      ) : null}
      {/* Câu trạng thái cho trình đọc màn hình: đọc một lần khi trạng thái đổi; không chứa số giây đếm ngược. */}
      <span className="sr-only" aria-live="polite">
        {announce}
      </span>
    </>
  );
}
