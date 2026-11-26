"use client";

import { useEffect, useSyncExternalStore } from "react";

import { useMarkRead } from "@/features/notifications/components/notification-panel";
import { useNotifications } from "@/lib/queries";

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
import { useRewardsWatch } from "./watch";

// Nguồn sự kiện của popup box mới nhận / vé trúng (#556).
//
// Nội dung popup (người gửi, cấp, vé) luôn đọc từ `lottery/ledger` + `lottery/draw/entries` của trình duyệt.
// - Watch phía server TẮT / tạm dừng: mốc "đã xem" ở localStorage theo ví (như #556).
// - Watch `active` (#558, DEC-398): nguồn sự kiện là thông báo server (`rewards_box_received` / `rewards_draw_won` chưa
//   đọc). Popup chỉ hiện khi còn tin server chưa đọc; đóng popup thì đánh dấu đã đọc các tin đó (mọi thiết bị thôi báo)
//   và ghi mốc localStorage như cũ (localStorage chỉ còn là dự phòng / lọc dòng ledger đã hiện).

export interface ReceivedSource {
  /** Sự kiện chưa báo; null khi chưa đủ dữ liệu hoặc chưa có mốc (lần ký đầu). */
  events: ReceivedEvents | null;
  /** Ghi "đã xem" cho mọi sự kiện đang hiện (mọi cách đóng popup). */
  ack: () => void;
}

/** Đọc thêm tối đa ngần này trang ledger khi cả trang đều mới hơn mốc. */
const MAX_LEDGER_PAGES = 5;

const SERVER_TYPES: readonly string[] = ["rewards_box_received", "rewards_draw_won"];

export function useReceivedEvents(session: RewardsSession): ReceivedSource {
  const master = session.signedIn ? session.master : null;
  const watch = useRewardsWatch(session.signedIn);
  const serverMode = watch.data?.status === "active";
  const notes = useNotifications(serverMode);
  const markRead = useMarkRead();
  const unread = serverMode
    ? (notes.data?.items ?? []).filter((n) => n.readAt === null && SERVER_TYPES.includes(n.type))
    : [];
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

  const local = ready && seen !== null ? newEvents(items, drawResult, seen) : null;
  // Watch active: chỉ báo khi server còn tin chưa đọc (nguồn sự kiện là server, không báo trùng giữa các thiết bị).
  const events = serverMode && (notes.data === undefined || unread.length === 0) ? null : local;
  return {
    events,
    ack: () => {
      for (const n of unread) markRead.mutate(n.id);
      if (master === null || events === null) return;
      // Đọc lại mốc ngay trước khi ghi (tab khác có thể vừa ghi).
      writeSeen(master, markSeen(readSeen(master) ?? seen ?? initialSeen([], null, 0), events));
    },
  };
}
