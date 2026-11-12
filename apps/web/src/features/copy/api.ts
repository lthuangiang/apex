"use client";

import {
  botSummarySchema,
  copyPreviewSchema,
  followingSchema,
  traderListSchema,
  traderProfileSchema,
  type CopyRequest,
  type TraderTab,
} from "@drift/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { z } from "zod";

import { api } from "@/lib/api";

// Hook gọi API Copy Trading (DEC-163, SCREENS.md 8.x).

export const useTraders = (tab: TraderTab) =>
  useQuery({
    queryKey: ["traders", tab],
    queryFn: () => api("GET", `/api/v1/traders?tab=${tab}`, traderListSchema),
  });

export const useTrader = (address: string) =>
  useQuery({
    queryKey: ["trader", address],
    queryFn: () => api("GET", `/api/v1/traders/${address}`, traderProfileSchema),
    retry: false,
  });

export const useFollowing = () =>
  useQuery({
    queryKey: ["following"],
    queryFn: () => api("GET", "/api/v1/following", followingSchema),
    refetchInterval: 60_000,
  });

export const useCopyPreview = (req: CopyRequest | null) =>
  useQuery({
    queryKey: ["copy-preview", req],
    queryFn: () => api("POST", "/api/v1/copy/preview", copyPreviewSchema, { body: req }),
    enabled: req !== null,
    placeholderData: (prev) => prev,
  });

/** Theo dõi / bỏ theo dõi; làm mới danh sách, hồ sơ và Following. */
export function useFollow() {
  const qc = useQueryClient();
  const key = useRef(crypto.randomUUID());
  return useMutation({
    mutationFn: (v: { address: string; on: boolean }) =>
      api(
        v.on ? "POST" : "DELETE",
        `/api/v1/traders/${v.address}/follow`,
        z.object({ following: z.boolean() }),
        {
          idempotencyKey: key.current,
        },
      ),
    onSettled: async () => {
      key.current = crypto.randomUUID();
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["traders"] }),
        qc.invalidateQueries({ queryKey: ["trader"] }),
        qc.invalidateQueries({ queryKey: ["following"] }),
      ]);
    },
  });
}

export function useStartCopy() {
  const key = useRef(crypto.randomUUID());
  return useMutation({
    mutationFn: (body: CopyRequest & { acknowledged: true; twoFactorCode?: string }) =>
      api("POST", "/api/v1/copy", botSummarySchema, { idempotencyKey: key.current, body }),
    onError: () => {
      key.current = crypto.randomUUID();
    },
  });
}
