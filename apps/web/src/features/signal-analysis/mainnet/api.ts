import {
  BotState,
  botSummarySchema,
  newsBotListSchema,
  newsBotSignalsSchema,
  newsBotVersionResultSchema,
  newsCommandSchema,
  newsTradeSchema,
  startChecksSchema,
  type NewsBotCreateBody,
  type NewsSignalConfig,
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

// #469: mỗi bot kèm Signal research version gốc (`signalVersionId`) cho màn Settings.
const listSchema = newsBotListSchema;

/** #458: lệnh mainnet kèm `leverage` (mức lúc vào, API trả từ #465); null = lệnh cũ, không hiện đòn bẩy. */
const mainnetTradeSchema = newsTradeSchema;
export type MainnetTrade = z.infer<typeof mainnetTradeSchema>;
const mainnetTradesSchema = z.object({ items: z.array(mainnetTradeSchema) });

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
    queryFn: () => api("GET", `${NEWS_BOTS_BASE}/${botId ?? ""}/trades`, mainnetTradesSchema),
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

export interface NewsVersionVars {
  botId: string;
  /** Config đầy đủ của version mới (chỉ 5 field sửa được khác version đang chạy). */
  config: NewsSignalConfig;
  twoFactorCode?: string;
}

/**
 * Edit bot news (#469): lưu thành version mới qua route chung `POST /bots/:id/versions`. Bot đang chạy / pause: version
 * `pending` tới khi engine áp ("Applying v{n}…" lấy từ `GET /bots/:id`); bot đã dừng: `active` ngay.
 */
export function useSaveNewsVersion(onDone?: (v: NewsVersionVars) => void) {
  const qc = useQueryClient();
  return useFinancialMutation({
    mutationFn: (v: NewsVersionVars, idempotencyKey: string) =>
      api("POST", `/api/v1/bots/${v.botId}/versions`, newsBotVersionResultSchema, {
        body: {
          config: v.config,
          paramSource: "manual",
          ...(v.twoFactorCode === undefined ? {} : { twoFactorCode: v.twoFactorCode }),
        },
        idempotencyKey,
      }),
    identity: (v) => [v.botId, v.config, v.twoFactorCode ?? null],
    refetch: (v) => [["bot", v.botId], NEWS_BOTS_KEY],
    onSuccess: async (_d, v) => {
      if (v.twoFactorCode !== undefined) void qc.invalidateQueries({ queryKey: ME_KEY });
      await qc.invalidateQueries({ queryKey: ["bot", v.botId] });
      onDone?.(v);
    },
  });
}
