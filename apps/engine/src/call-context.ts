import { newTraceId, withSodexCallContext } from "@drift/sodex";

import type { Gateway } from "./gateway";

// SoDEX Debugger (DEC-309): mọi lời gọi SoDEX trong một thao tác của bot (đặt, huỷ, đối soát…) mang
// botId, accountId và một traceId chung, để trang debugger nối được các lời gọi liên quan. Chỉ gắn ngữ cảnh, không đổi
// tham số hay kết quả.
export function withBotCallContext(gateway: Gateway, botId: string, accountId: string): Gateway {
  return new Proxy(gateway, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      const fn = value as (...args: unknown[]) => unknown;
      return (...args: unknown[]): unknown =>
        withSodexCallContext({ botId, accountId, traceId: newTraceId() }, () =>
          fn.apply(target, args),
        );
    },
  });
}
