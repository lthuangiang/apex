"use client";

import { featuresSchema } from "@drift/shared";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { NotFoundPage } from "@/features/public";
import { api } from "@/lib/api";

/**
 * Bot khối lượng (Volume Maker, Volume Farm) chỉ mở được khi admin bật cho tài khoản (DEC-80). Chưa bật thì
 * trang như không tồn tại; api cũng trả NOT_FOUND nên không lách được bằng cách gọi thẳng.
 */
export function VolumeGate({
  strategy,
  children,
}: {
  strategy: "volume_maker" | "volume_farm" | "adaptive_dca" | "copy_trade";
  children: ReactNode;
}) {
  const features = useQuery({
    queryKey: ["features"],
    queryFn: () => api("GET", "/api/v1/features", featuresSchema),
    staleTime: 60_000,
  });
  if (features.isPending) return null;
  // AI Adaptive DCA (thử nghiệm, DEC-107) và Copy Trade (DEC-161) đi theo cờ AI Desk.
  const on =
    strategy === "volume_maker"
      ? features.data?.volumeMaker
      : strategy === "volume_farm"
        ? features.data?.volumeFarm
        : features.data?.aiDesk;
  return on === true ? <>{children}</> : <NotFoundPage signedIn />;
}
