"use client";

import { useEffect, useSyncExternalStore } from "react";

import { useRewardsDrawEntries, useRewardsLedger, type RewardsSession } from "./queries";
import {
  drawResultOf,
  initialSeen,
  markSeen,
  newEvents,
  readSeen,
  readSeenRaw,
  subscribeSeen,
  writeSeen,
  type ReceivedEvents,
  type Seen,
} from "./received";

// Nguồn sự kiện của popup box mới nhận / vé trúng (#556).
//
// Hiện tại: trình duyệt so `lottery/ledger` + `lottery/draw/entries` với mốc "đã xem" trong localStorage (bản phác).
// TODO(#558 PR4 / PR5): khi người dùng bật theo dõi phía server (watch active), đọc sự kiện từ thông báo server thay cho
// localStorage, giữ nguyên interface `ReceivedSource` để popup không đổi. PR4 chưa merge lúc làm #556.

export interface ReceivedSource {
  /** Sự kiện chưa báo; null khi chưa đủ dữ liệu hoặc chưa có mốc (lần ký đầu). */
  events: ReceivedEvents | null;
  /** Ghi "đã xem" cho mọi sự kiện đang hiện (mọi cách đóng popup). */
  ack: () => void;
}

/** Đọc thêm tối đa ngần này trang ledger khi cả trang đều mới hơn mốc. */
const MAX_LEDGER_PAGES = 5;

export function useReceivedEvents(session: RewardsSession): ReceivedSource {
  const master = session.signedIn ? session.master : null;
  const ledger = useRewardsLedger(session);
  const draw = useRewardsDrawEntries(session);
  const raw = useSyncExternalStore(
    subscribeSeen,
    () => readSeenRaw(master),
    () => null,
  );
  const seen: Seen | null = raw === null ? null : readSeen(master);
  const items = (ledger.data?.pages ?? []).flatMap((p) => p.items);
  const drawResult = drawResultOf(draw.data);
  const ready = ledger.data !== undefined && (draw.data !== undefined || draw.isError);

  // Lần ký đầu trên trình duyệt: đặt mốc = hiện có, không báo lịch sử cũ.
  useEffect(() => {
    if (!ready || master === null || raw !== null) return;
    writeSeen(master, initialSeen(items, drawResult, Date.now()));
    // Chỉ khi dữ liệu vừa đủ hoặc ví đổi; `items` / `drawResult` đọc tại thời điểm đó.
  }, [ready, master, raw]);

  // Cả các trang đã đọc đều mới hơn mốc: đọc thêm trang (100 dòng / trang).
  const pages = ledger.data?.pages.length ?? 0;
  const oldest = items.at(-1)?.tsMs;
  useEffect(() => {
    if (seen === null || oldest === undefined || !ledger.hasNextPage) return;
    if (ledger.isFetchingNextPage || pages >= MAX_LEDGER_PAGES) return;
    if (oldest > seen.ledgerTsMs) void ledger.fetchNextPage();
  }, [seen, oldest, pages, ledger]);

  const events = ready && seen !== null ? newEvents(items, drawResult, seen) : null;
  return {
    events,
    ack: () => {
      if (master === null || events === null) return;
      // Đọc lại mốc ngay trước khi ghi (tab khác có thể vừa ghi).
      writeSeen(master, markSeen(readSeen(master) ?? seen ?? initialSeen([], null, 0), events));
    },
  };
}
