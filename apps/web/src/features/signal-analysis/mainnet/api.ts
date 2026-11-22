import {
  BotState,
  botSummarySchema,
  newsBotSignalsSchema,
  newsCommandSchema,
  newsTradesSchema,
  startChecksSchema,
  type NewsBotCreateBody,
  type NewsTpslBody,
} from "@drift/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";

import { api } from "@/lib/api";
import { useFinancialMutation } from "@/lib/financial-action";
import { ME_KEY } from "@/lib/queries";

// Query / mutation của bot `news_signal` mainnet (#421, API #443). Mọi trạng thái lấy từ backend (quy tắc 1.6): sau mỗi
// thao tác chỉ đọc lại, không tự đổi state trên web. Lệnh tài chính dùng `useFinancialMutation` (cùng Idempotency-Key khi
// gửi lại, kết quả không rõ thì đọc lại rồi mới mở nút).

export const NEWS_BOTS_BASE = "/api/v1/signal-research/bots";
export const NEWS_BOTS_KEY = ["newsBots"] as const;
const botKey = (id: string | null) => [...NEWS_BOTS_KEY, id] as const;

const listSchema = z.object({ items: z.array(botSummarySchema) });

/** Trạng thái chuyển tiếp của bot: thăm dò nhanh tới khi backend xác nhận. */
export const TRANSITIONAL_STATES: readonly string[] = [
  BotState.starting,
  BotState.pausing,
  BotState.resuming,
  BotState.stopping,
];

export function useNewsBots(enabled: boolean) {
  return useQuery({
    queryKey: NEWS_BOTS_KEY,
    queryFn: () => api("GET", NEWS_BOTS_BASE, listSchema),
    enabled,
    refetchInterval: (q) =>
      q.state.data?.items.some((b) => TRANSITIONAL_STATES.includes(b.state)) === true
        ? 1_000
        : 10_000,
  });
}

export function useNewsTrades(botId: string | null) {
  return useQuery({
    queryKey: [...botKey(botId), "trades"],
    queryFn: () => api("GET", `${NEWS_BOTS_BASE}/${botId ?? ""}/trades`, newsTradesSchema),
    enabled: botId !== null,
    // Lệnh đang đóng / command chưa xong: đọc lại mỗi giây tới khi engine xác nhận.
    refetchInterval: (q) =>
      q.state.data?.items.some((x) => x.pendingCommand !== null || x.status === "closing") === true
        ? 1_000
        : 5_000,
  });
}

export function useNewsBotSignals(botId: string | null) {
  return useQuery({
    queryKey: [...botKey(botId), "signals"],
    queryFn: () => api("GET", `${NEWS_BOTS_BASE}/${botId ?? ""}/signals`, newsBotSignalsSchema),
    enabled: botId !== null,
    refetchInterval: 30_000,
  });
}

export function useNewsBotChecks(botId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: [...botKey(botId), "checks"],
    queryFn: () => api("GET", `/api/v1/bots/${botId ?? ""}/checks`, startChecksSchema),
    enabled: enabled && botId !== null,
  });
}

export type NewsBotAction = "start" | "pause" | "resume" | "stop";

export interface NewsBotActionVars {
  id: string;
  action: NewsBotAction;
  /** Start: xác nhận + mã 2FA (nếu cần). Stop: `closePosition` = "Close all now". */
  body: { acknowledged?: boolean; twoFactorCode?: string; closePosition?: boolean };
}

/** Start / Pause / Resume / Stop qua route chung của bot (202, trạng thái chuyển tiếp từ backend). */
export function useNewsBotAction(onDone?: (v: NewsBotActionVars) => void) {
  const qc = useQueryClient();
  return useFinancialMutation({
    mutationFn: (v: NewsBotActionVars, idempotencyKey: string) =>
      api("POST", `/api/v1/bots/${v.id}/actions/${v.action}`, botSummarySchema, {
        body: v.body,
        idempotencyKey,
      }),
    identity: (v) => [v.id, v.action, v.body],
    refetch: [NEWS_BOTS_KEY],
    onSuccess: async (_d, v) => {
      // Start vừa nhập mã 2FA: phiên được tin 2 giờ (DEC-115).
      if (v.action === "start") void qc.invalidateQueries({ queryKey: ME_KEY });
      await qc.invalidateQueries({ queryKey: NEWS_BOTS_KEY });
      onDone?.(v);
    },
  });
}

/** Tạo bot (draft) từ một version. */
export function useCreateNewsBot() {
  const qc = useQueryClient();
  return useFinancialMutation({
    mutationFn: (body: NewsBotCreateBody, idempotencyKey: string) =>
      api("POST", NEWS_BOTS_BASE, botSummarySchema, { body, idempotencyKey }),
    refetch: [NEWS_BOTS_KEY],
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: NEWS_BOTS_KEY });
    },
  });
}

export interface NewsCommandVars {
  botId: string;
  tradeId: string;
  kind: "close" | "edit_tpsl";
  body?: NewsTpslBody;
}

/** Close now / Edit TP/SL: API ghi command `queued`, engine xử lý; web chỉ đọc lại bảng lệnh. */
export function useNewsCommand(onDone?: () => void) {
  const qc = useQueryClient();
  return useFinancialMutation({
    mutationFn: (v: NewsCommandVars, idempotencyKey: string) =>
      api(
        "POST",
        `${NEWS_BOTS_BASE}/${v.botId}/trades/${v.tradeId}/${v.kind === "close" ? "close" : "tpsl"}`,
        newsCommandSchema,
        { ...(v.body === undefined ? {} : { body: v.body }), idempotencyKey },
      ),
    identity: (v) => [v.tradeId, v.kind, v.body ?? null],
    refetch: (v) => [[...botKey(v.botId), "trades"]],
    onSuccess: async (_d, v) => {
      await qc.invalidateQueries({ queryKey: [...botKey(v.botId), "trades"] });
      onDone?.();
    },
  });
}
