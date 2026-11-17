import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

// Ngữ cảnh gắn vào mỗi lời gọi SoDEX cho SoDEX Debugger (DEC-309): bot, account (id trong DB) và
// traceId. Đặt ở chỗ gọi (engine theo từng thao tác của bot, api theo request) bằng `withSodexCallContext`; client đọc
// lúc ghi. Không có ngữ cảnh thì các field là null.

export interface SodexCallContext {
  botId?: string;
  /** `sodex_accounts.id`. */
  accountId?: string;
  traceId?: string;
}

const storage = new AsyncLocalStorage<SodexCallContext>();

/** 16 ký tự hex, đủ để nối các lời gọi của cùng một thao tác. */
export function newTraceId(): string {
  return randomBytes(8).toString("hex");
}

/** Chạy `fn` với ngữ cảnh mới, gộp lên ngữ cảnh đang có (field mới thắng). */
export function withSodexCallContext<T>(context: SodexCallContext, fn: () => T): T {
  const parent = storage.getStore();
  return storage.run(parent === undefined ? context : { ...parent, ...context }, fn);
}

export function currentSodexCallContext(): SodexCallContext | undefined {
  return storage.getStore();
}
