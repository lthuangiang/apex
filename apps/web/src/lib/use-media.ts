"use client";

import { useSyncExternalStore } from "react";

/** `true` khi media query khớp; render phía server luôn `false`. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia(query);
      mq.addEventListener("change", cb);
      return () => {
        mq.removeEventListener("change", cb);
      };
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** Dưới 1024 px: có bottom nav của AppShell (cùng breakpoint `lg`). */
export const BELOW_LG = "(max-width: 1023px)";
