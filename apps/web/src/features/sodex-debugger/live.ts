"use client";

import type { SodexCallItem, SodexCallsPage } from "@drift/shared";
import { useEffect, useRef, useState } from "react";

// Chế độ Live của SoDEX Debugger: tô dòng mới ~3 s, báo cho trình đọc màn hình tối đa mỗi 30 s, đếm dòng mới khi
// Live đang dừng.

export const FRESH_MS = 3_000;
export const ANNOUNCE_EVERY_MS = 30_000;
const SEEN_CAP = 2_000;

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Dòng của trang đầu chưa từng thấy kể từ lần xem trước (cùng bộ lọc `resetKey`). Lần tải đầu và khi đổi bộ lọc
 * không tô. `announce(n)` được gọi tối đa mỗi 30 s, cộng dồn số dòng mới chưa báo.
 */
export function useFreshRows(
  firstPageIds: readonly string[] | undefined,
  resetKey: string,
  announce: (n: number) => void,
): ReadonlySet<string> {
  const [fresh, setFresh] = useState<ReadonlySet<string>>(() => new Set());
  const seen = useRef<{ key: string; ids: Set<string> } | null>(null);
  const pending = useRef(0);
  const lastAnnounce = useRef(0);
  const announceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const freshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const announceRef = useRef(announce);
  announceRef.current = announce;
  const idsKey = firstPageIds?.join(",");

  useEffect(
    () => () => {
      if (announceTimer.current !== null) clearTimeout(announceTimer.current);
      if (freshTimer.current !== null) clearTimeout(freshTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (idsKey === undefined) return;
    const ids = idsKey === "" ? [] : idsKey.split(",");
    const prev = seen.current;
    if (prev?.key !== resetKey) {
      seen.current = { key: resetKey, ids: new Set(ids) };
      pending.current = 0;
      setFresh(new Set());
      return;
    }
    const added = ids.filter((id) => !prev.ids.has(id));
    const ids2 = prev.ids.size > SEEN_CAP ? new Set(ids) : prev.ids;
    for (const id of ids) ids2.add(id);
    seen.current = { key: resetKey, ids: ids2 };
    if (added.length === 0) return;

    setFresh(new Set(added));
    if (freshTimer.current !== null) clearTimeout(freshTimer.current);
    freshTimer.current = setTimeout(() => {
      freshTimer.current = null;
      setFresh(new Set());
    }, FRESH_MS);

    pending.current += added.length;
    const flush = () => {
      const wait = lastAnnounce.current + ANNOUNCE_EVERY_MS - Date.now();
      if (wait > 0) {
        announceTimer.current ??= setTimeout(() => {
          announceTimer.current = null;
          flush();
        }, wait);
        return;
      }
      if (pending.current > 0) announceRef.current(pending.current);
      pending.current = 0;
      lastAnnounce.current = Date.now();
    };
    flush();
  }, [idsKey, resetKey]);

  return fresh;
}

/**
 * Số dòng mới trong trang đầu mới nhất (`head`) so với danh sách đang xem, dạng chữ cho "{n} new calls"; `null` khi
 * không có. Khi không dòng nào trùng và còn trang sau, có thể còn nhiều hơn: "50+".
 */
export function countNew(head: SodexCallsPage | undefined, shown: SodexCallItem[]): string | null {
  const top = shown[0];
  if (head === undefined || top === undefined) return null;
  const ids = new Set(shown.map((x) => x.id));
  const since = Date.parse(top.at);
  const added = head.items.filter((x) => !ids.has(x.id) && Date.parse(x.at) >= since).length;
  if (added === 0) return null;
  const overlap = head.items.some((x) => ids.has(x.id));
  return !overlap && added === head.items.length && head.nextCursor !== null
    ? `${String(added)}+`
    : String(added);
}
