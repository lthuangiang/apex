"use client";

import {
  useMutation,
  useQueryClient,
  type QueryClient,
  type QueryKey,
  type UseMutationResult,
} from "@tanstack/react-query";
import { useRef, useState } from "react";

import { ApiError } from "./api";

// Thao tác tài chính (Start / Pause / Resume / Stop bot, áp version, SoDEX connect / approve / revoke / disconnect /
// gửi chữ ký, copy, AI Desk apply) mà không biết kết quả thì KHÔNG cho bấm lại ngay (quy tắc 1.6, 1.7, #318):
// giữ trạng thái chuyển tiếp, đọc lại trạng thái từ backend, chỉ mở lại nút khi đã đọc được.

/** Vì sao kết quả của một request ghi không rõ; `null` = kết quả rõ (thành công hoặc lỗi chắc chắn). */
export type UncertainOutcome = "network" | "server" | "unknown" | "in_progress";

export function uncertainOutcome(error: unknown): UncertainOutcome | null {
  if (!(error instanceof ApiError)) return null;
  if (error.code === "NETWORK") return "network";
  if (error.code === "IDEMPOTENCY_KEY_CONFLICT") {
    const reason = (error.details as { reason?: unknown }).reason;
    if (reason === "unknown") return "unknown";
    if (reason === "in_progress") return "in_progress";
    return null;
  }
  return error.status >= 500 ? "server" : null;
}

/** Thời gian chờ trước lần gửi lại tự động (cùng Idempotency-Key). */
export const SAME_KEY_RETRY_MS = 1500;
/** Số lần thử đọc lại trạng thái trước khi mở lại nút. */
export const REFETCH_ATTEMPTS = 3;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Gửi một request ghi với MỘT Idempotency-Key. Lỗi mạng hoặc 409 `in_progress` (request có thể đã tới server) thì gửi
 * lại một lần với cùng key: server phát lại kết quả đã có, hoặc vẫn báo đang chạy. Không bao giờ đổi key.
 */
export async function sendWithSameKey<T>(
  send: (idempotencyKey: string) => Promise<T>,
  key: string = crypto.randomUUID(),
  retryDelayMs: number = SAME_KEY_RETRY_MS,
): Promise<T> {
  try {
    return await send(key);
  } catch (error) {
    const why = uncertainOutcome(error);
    if (why !== "network" && why !== "in_progress") throw error;
    await sleep(retryDelayMs);
    return send(key);
  }
}

/**
 * Đọc lại các query giữ trạng thái thật (bot, kết nối SoDEX…) sau một kết quả không rõ. Thử tối đa
 * `REFETCH_ATTEMPTS` lần; trả `true` khi đã đọc được.
 */
export async function readBackState(
  qc: QueryClient,
  keys: readonly QueryKey[],
  retryDelayMs: number = SAME_KEY_RETRY_MS,
): Promise<boolean> {
  for (let attempt = 1; attempt <= REFETCH_ATTEMPTS; attempt += 1) {
    try {
      await Promise.all(
        keys.map((queryKey) => qc.refetchQueries({ queryKey }, { throwOnError: true })),
      );
      return true;
    } catch {
      if (attempt < REFETCH_ATTEMPTS) await sleep(retryDelayMs * attempt);
    }
  }
  return false;
}

export interface FinancialMutationOptions<TData, TVars> {
  /** Gửi request với đúng `idempotencyKey` được đưa vào (không tự sinh key). */
  mutationFn: (vars: TVars, idempotencyKey: string) => Promise<TData>;
  /** Query giữ trạng thái thật của tài nguyên (bot, kết nối SoDEX…), đọc lại khi kết quả không rõ. */
  refetch: QueryKey[] | ((vars: TVars) => QueryKey[]);
  onSuccess?: (data: TData, vars: TVars) => unknown;
  onError?: (error: Error, vars: TVars) => unknown;
  /** Cái xác định "cùng một thao tác" cho key (mặc định `vars`); gồm cả body nếu body lấy từ state của màn hình. */
  identity?: (vars: TVars) => unknown;
  retryDelayMs?: number;
}

export type FinancialMutation<TData, TVars> = UseMutationResult<TData, Error, TVars> & {
  /** Đang đọc lại trạng thái sau một kết quả không rõ (nút vẫn khoá: `isPending` còn true). */
  checking: boolean;
};

/**
 * `useMutation` cho thao tác tài chính.
 * - Một Idempotency-Key cho một ý định (cùng `vars`); thành công hoặc lỗi chắc chắn thì key được bỏ.
 * - Lỗi mạng hoặc 409 `in_progress`: request có thể đã tới server, nên gửi lại MỘT lần với CÙNG key (server phát lại
 *   kết quả, hoặc báo vẫn đang chạy). Không bao giờ gửi lại với key mới.
 * - Vẫn không rõ (lỗi mạng, 5xx, 409 `unknown` / `in_progress`): đọc lại `refetch` trước khi mở lại nút; `isPending`
 *   giữ true trong lúc đọc. 5xx / `unknown` thì server đã giữ key ở `failed_unknown`, nên bỏ key: lần bấm sau (khi
 *   đã thấy trạng thái thật) dùng key mới. Lỗi mạng / `in_progress` thì giữ key: bấm lại cùng thao tác vẫn nối vào
 *   request cũ.
 */
export function useFinancialMutation<TData, TVars>(
  options: FinancialMutationOptions<TData, TVars>,
): FinancialMutation<TData, TVars> {
  const qc = useQueryClient();
  const keyRef = useRef<{ key: string; vars: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const retryDelay = options.retryDelayMs ?? SAME_KEY_RETRY_MS;

  const keyFor = (vars: TVars) => {
    const id = JSON.stringify((options.identity ?? ((v: TVars) => v))(vars) ?? null);
    if (keyRef.current?.vars !== id) keyRef.current = { key: crypto.randomUUID(), vars: id };
    return keyRef.current.key;
  };

  const readBack = (vars: TVars) =>
    readBackState(
      qc,
      typeof options.refetch === "function" ? options.refetch(vars) : options.refetch,
      retryDelay,
    );

  const m = useMutation<TData, Error, TVars>({
    mutationFn: (vars) =>
      sendWithSameKey((key) => options.mutationFn(vars, key), keyFor(vars), retryDelay),
    onSuccess: async (data, vars) => {
      keyRef.current = null;
      await options.onSuccess?.(data, vars);
    },
    // react-query chờ callback này xong mới chuyển sang `error`, nên nút còn khoá trong lúc đọc lại.
    onError: async (error, vars) => {
      const why = uncertainOutcome(error);
      if (why === null || why === "unknown" || why === "server") keyRef.current = null;
      if (why !== null) {
        setChecking(true);
        try {
          await readBack(vars);
        } finally {
          setChecking(false);
        }
      }
      await options.onError?.(error, vars);
    },
  });
  return { ...m, checking };
}
