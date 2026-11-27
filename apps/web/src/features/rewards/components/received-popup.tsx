"use client";

import type { LotteryLedgerItem } from "@drift/shared";
import { BottomSheet, Button } from "@drift/ui";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { shortAddress } from "@/lib/format";
import { valueChain } from "@/lib/wagmi";

import { browserZone, formatDayTime, levelDotClass } from "../format";
import type { RewardsSession } from "../queries";
import { emptyEvents, levelCounts, type DrawResult, type ReceivedEvents } from "../received";
import { useActionState } from "../use-box-actions";
import { useReceivedEvents } from "../use-received";

import { BoxArt } from "./box-art";

// Popup box mới nhận / vé trúng (#556; bản phác docs/mockups/rewards/received/, người dùng duyệt 2026-11-26). Chỉ ở
// Overview và /rewards, khi đã ký. Chỉ là thông báo đọc: không có thao tác chuyển box (quy tắc sản phẩm 1). Xếp hàng sau
// popup Claim / Open / Merge: popup thao tác đang mở thì chờ. Mọi cách đóng đều ghi "đã xem".

const LIST_MAX = 5;
const ANIM_PRIZE_MAX = 5;

/** Link tx trên explorer cấu hình trong wagmi.ts (PM chốt); không có txHash / explorer thì null. */
export function txUrl(txHash: string | null | undefined): string | null {
  const base = valueChain.blockExplorers.default.url;
  if (txHash == null || txHash === "") return null;
  return `${base}/tx/${txHash}`;
}

function Level({ level }: { level: string | null | undefined }) {
  const t = useTranslations("rewards.received");
  const name = level == null || level === "" ? null : level;
  return (
    <span className="inline-flex items-center gap-1.5 font-extrabold">
      <span
        aria-hidden="true"
        className={`size-3 flex-none rounded-[4px] ${name === null ? "bg-border-input" : levelDotClass(name)}`}
      />
      {name ?? t("box")}
    </span>
  );
}

function Sender({ row }: { row: LotteryLedgerItem }) {
  if (row.from == null || row.from === "") return null;
  const text = shortAddress(row.from);
  const url = txUrl(row.txHash);
  return url === null ? (
    <span className="tabular-nums">{text}</span>
  ) : (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="font-bold text-accent-ink no-underline tabular-nums"
    >
      {text} ↗
    </a>
  );
}

/** Box nở / rơi; reduced motion chỉ mờ dần. */
function BigBox({ row, delay = 0 }: { row: LotteryLedgerItem; delay?: number }) {
  return (
    <div
      style={{ animationDelay: `${String(delay)}ms` }}
      className="flex flex-col items-center gap-1 px-6 py-2 motion-safe:animate-[rw-fall_420ms_cubic-bezier(.3,1.5,.5,1)_both] motion-reduce:animate-[rw-fade_120ms_linear]"
    >
      <BoxArt level={row.level} size={96} />
      <Level level={row.level} />
      {row.tokenId == null ? null : (
        <span className="text-xs text-ink-2 tabular-nums">#{row.tokenId}</span>
      )}
    </div>
  );
}

function PrizeBox({ row, i }: { row: LotteryLedgerItem; i: number }) {
  const url = txUrl(row.txHash);
  const animated = i < ANIM_PRIZE_MAX;
  return (
    <li
      style={animated ? { animationDelay: `${String(200 + i * 120)}ms` } : undefined}
      className={`flex flex-col items-center gap-0.5 rounded-[14px] bg-surface-2 px-3 py-2.5 text-xs ${animated ? "motion-safe:animate-[rw-pop_320ms_cubic-bezier(.3,1.4,.5,1)_both]" : ""} motion-reduce:animate-[rw-fade_120ms_linear]`}
    >
      <BoxArt level={row.level} size={40} />
      <Level level={row.level} />
      {row.tokenId == null ? null : url === null ? (
        <span className="text-ink-2 tabular-nums">#{row.tokenId}</span>
      ) : (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="font-bold text-accent-ink no-underline tabular-nums"
        >
          #{row.tokenId} ↗
        </a>
      )}
    </li>
  );
}

function ReceivedList({ rows, tz }: { rows: readonly LotteryLedgerItem[]; tz: string }) {
  const tm = useTranslations("rewards.action.ids");
  const t = useTranslations("rewards.received");
  return (
    <>
      <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
        {levelCounts(rows).map((c, i) => (
          <li
            key={c.level}
            style={{ animationDelay: `${String(i * 60)}ms` }}
            className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-2.5 py-1 text-xs font-extrabold motion-safe:animate-[rw-chip_200ms_ease-out_both] motion-reduce:animate-[rw-fade_120ms_linear]"
          >
            <span
              aria-hidden="true"
              className={`size-2.5 rounded-[3px] ${levelDotClass(c.level)}`}
            />
            {t("levelCount", { n: c.n, level: c.level })}
          </li>
        ))}
      </ul>
      <ul className="m-0 flex list-none flex-col p-0 text-sm">
        {rows.slice(0, LIST_MAX).map((r, i) => (
          <li
            key={`${String(r.tokenId)}:${String(r.tsMs)}:${String(i)}`}
            className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 border-b border-border py-2 last:border-b-0"
          >
            <span className="inline-flex items-center gap-2">
              <Level level={r.level} />
              {r.tokenId == null ? null : (
                <span className="text-ink-2 tabular-nums">#{r.tokenId}</span>
              )}
            </span>
            <span className="flex flex-col items-end text-xs">
              <Sender row={r} />
              <span className="text-ink-2 tabular-nums">{formatDayTime(r.tsMs, tz)}</span>
            </span>
          </li>
        ))}
        {rows.length > LIST_MAX ? (
          <li className="py-2 text-xs text-ink-2">{tm("more", { n: rows.length - LIST_MAX })}</li>
        ) : null}
      </ul>
    </>
  );
}

function WonTickets({ draw }: { draw: DrawResult }) {
  const t = useTranslations("rewards.received");
  const td = useTranslations("rewards.boxes.draw");
  return (
    <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-sm">
      {draw.won.slice(0, LIST_MAX).map((w) => (
        <li
          key={w.tokenId}
          className="flex flex-wrap items-center justify-between gap-2 rounded-tile bg-pos-bg px-3 py-2"
        >
          <span className="inline-flex items-center gap-2">
            <span className="text-xs text-ink-2">{t("ticket")}</span>
            <b className="tabular-nums">#{w.tokenId}</b>
            <Level level={w.level} />
          </span>
          {w.prizeLevel === null ? null : (
            <span className="font-bold text-pos">{td("prize", { level: w.prizeLevel })}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

function PrizeSection({ round, items }: { round: number | null; items: LotteryLedgerItem[] }) {
  const td = useTranslations("rewards.boxes.draw");
  return (
    <div className="flex flex-col gap-2">
      {round === null ? null : <b className="text-sm">{td("received", { round })}</b>}
      <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
        {items.map((r, i) => (
          <PrizeBox key={`${String(r.tokenId)}:${String(i)}`} row={r} i={i} />
        ))}
      </ul>
    </div>
  );
}

export function titleOf(
  e: ReceivedEvents,
  t: ReturnType<typeof useTranslations<"rewards.received">>,
  td: ReturnType<typeof useTranslations<"rewards.boxes.draw">>,
): string {
  const hasDraw = e.draw !== null || e.prizes.length > 0;
  if (hasDraw && e.received.length > 0) return t("combined");
  if (e.draw !== null)
    return td("won", { wins: e.draw.wins, tickets: e.draw.tickets ?? e.draw.wins });
  if (e.prizes.length > 0) return t("prizeOnly");
  const first = e.received[0];
  if (e.received.length === 1 && first !== undefined)
    return first.level == null || first.level === ""
      ? t("titleOneNoLevel")
      : t("titleOne", { level: first.level });
  return t("titleMany", { n: e.received.length });
}

function Body({ events, tz, onView }: { events: ReceivedEvents; tz: string; onView: () => void }) {
  const t = useTranslations("rewards.received");
  const ta = useTranslations("rewards.action");
  const td = useTranslations("rewards.boxes.draw");
  const tf = useTranslations("rewards.boxes.from");
  const draw = events.draw;
  const drawPrizes = draw === null ? [] : events.prizes.filter((p) => p.round === draw.round);
  const otherPrizes = events.prizes.filter((p) => p.round !== draw?.round);
  const combined = (draw !== null || events.prizes.length > 0) && events.received.length > 0;
  const one =
    events.received.length === 1 && !combined && draw === null && events.prizes.length === 0;
  const first = events.received[0];

  return (
    <div className="flex flex-col gap-3 motion-safe:animate-[rw-in_180ms_cubic-bezier(.2,.8,.2,1)] motion-reduce:animate-[rw-fade_120ms_linear]">
      {draw === null ? null : combined ? (
        <div className="flex flex-col gap-2">
          <b className="text-sm">
            {t("drawRound", { round: draw.round })} ·{" "}
            {td("won", { wins: draw.wins, tickets: draw.tickets ?? draw.wins })}
          </b>
          <WonTickets draw={draw} />
        </div>
      ) : (
        <>
          <p className="m-0 text-xs text-ink-2">
            {t("drawRound", { round: draw.round })} · {draw.status}
          </p>
          <WonTickets draw={draw} />
        </>
      )}
      {drawPrizes.map((p) => (
        <PrizeSection key={String(p.round)} round={p.round} items={p.items} />
      ))}
      {otherPrizes.map((p) => (
        <div key={String(p.round)} className="flex flex-col gap-2">
          <PrizeSection round={p.round} items={p.items} />
          {p.round === null ? null : (
            <p className="m-0 text-xs text-ink-2">
              {tf("prize")} · {tf("round", { round: p.round })}
            </p>
          )}
        </div>
      ))}
      {one && first !== undefined ? (
        <>
          <div className="flex justify-center">
            <BigBox row={first} />
          </div>
          <div className="flex flex-wrap justify-between gap-2 text-sm">
            {first.from == null || first.from === "" ? (
              <span />
            ) : (
              <span>
                {t("from")} <Sender row={first} />
              </span>
            )}
            <span className="text-ink-2 tabular-nums">
              {t("receivedAt", { time: formatDayTime(first.tsMs, tz) ?? "" })}
            </span>
          </div>
        </>
      ) : events.received.length > 0 ? (
        <div
          style={combined ? { animationDelay: "200ms" } : undefined}
          className="flex flex-col gap-2 motion-safe:animate-[rw-fade_200ms_ease-out_both]"
        >
          {combined ? (
            <b className="text-sm">{t("receivedCount", { n: events.received.length })}</b>
          ) : null}
          <ReceivedList rows={events.received} tz={tz} />
        </div>
      ) : null}
      <p className="m-0 text-xs text-ink-2">{t("findLater")}</p>
      <div className="flex flex-wrap gap-2.5 pt-1">
        <Link
          href="/rewards?tab=boxes"
          onClick={onView}
          className="flex min-h-tap items-center rounded-control bg-accent px-4 text-sm font-semibold text-white no-underline"
        >
          {t("viewBoxes")}
        </Link>
        <Button variant="secondary" onClick={onView}>
          {ta("close")}
        </Button>
      </div>
    </div>
  );
}

/** Gắn ở thẻ Overview và trang /rewards khi đã ký. */
export function ReceivedPopup({ session }: { session: RewardsSession }) {
  const t = useTranslations("rewards.received");
  const td = useTranslations("rewards.boxes.draw");
  const ta = useTranslations("rewards.action");
  const { events, ack } = useReceivedEvents(session);
  const action = useActionState();
  const [tz, setTz] = useState("UTC");
  useEffect(() => {
    setTz(browserZone());
  }, []);
  // Xếp hàng sau popup Claim / Open / Merge; mỗi lần một popup.
  if (events === null || emptyEvents(events) || action.open) return null;
  return (
    <BottomSheet
      open
      onOpenChange={(o) => {
        if (!o) ack();
      }}
      title={titleOf(events, t, td)}
      closeLabel={ta("close")}
    >
      <Body events={events} tz={tz} onView={ack} />
    </BottomSheet>
  );
}
