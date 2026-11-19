// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../api";
import { sendWithSameKey, uncertainOutcome, useFinancialMutation } from "../financial-action";

// Thao tác tài chính không rõ kết quả (#318): không cho bấm lại ngay, đọc lại trạng thái từ backend, và mọi lần gửi lại
// tự động dùng CÙNG Idempotency-Key.

const network = () => new ApiError("NETWORK", 0);
const conflict = (reason: string) =>
  new ApiError("IDEMPOTENCY_KEY_CONFLICT", 409, { reason, errorCode: "INTERNAL_ERROR" });
const serverError = () => new ApiError("SODEX_UNAVAILABLE", 503);
const stateConflict = () => new ApiError("BOT_STATE_CONFLICT", 409, { state: "running" });

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

afterEach(cleanup);

describe("uncertainOutcome", () => {
  it("treats network errors, 5xx and 409 unknown / in_progress as unknown outcomes", () => {
    expect(uncertainOutcome(network())).toBe("network");
    expect(uncertainOutcome(serverError())).toBe("server");
    expect(uncertainOutcome(new ApiError("INTERNAL_ERROR", 500))).toBe("server");
    expect(uncertainOutcome(conflict("unknown"))).toBe("unknown");
    expect(uncertainOutcome(conflict("in_progress"))).toBe("in_progress");
  });

  it("treats checked refusals and other conflicts as known outcomes", () => {
    expect(uncertainOutcome(stateConflict())).toBeNull();
    expect(uncertainOutcome(new ApiError("IDEMPOTENCY_KEY_CONFLICT", 409))).toBeNull();
    expect(uncertainOutcome(conflict("response_not_stored"))).toBeNull();
    expect(uncertainOutcome(new ApiError("TWO_FACTOR_REQUIRED", 401))).toBeNull();
    expect(uncertainOutcome(new Error("boom"))).toBeNull();
  });
});

describe("sendWithSameKey", () => {
  it("retries a network error or in_progress once with the same key", async () => {
    const keys: string[] = [];
    const send = vi.fn((key: string) => {
      keys.push(key);
      return keys.length === 1 ? Promise.reject(conflict("in_progress")) : Promise.resolve("ok");
    });
    await expect(sendWithSameKey(send, "key-1", 0)).resolves.toBe("ok");
    expect(keys).toEqual(["key-1", "key-1"]);
  });

  it("never retries an unknown outcome the server already holds, or a refusal", async () => {
    for (const error of [conflict("unknown"), serverError(), stateConflict()]) {
      const send = vi.fn(() => Promise.reject(error));
      await expect(sendWithSameKey(send, "key-1", 0)).rejects.toBe(error);
      expect(send).toHaveBeenCalledTimes(1);
    }
  });
});

describe("useFinancialMutation", () => {
  function setup(results: (() => Promise<string>)[], read: () => Promise<string>) {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const keys: string[] = [];
    let call = 0;
    const send = (_vars: string, key: string) => {
      keys.push(key);
      const next = results[call] ?? (() => Promise.resolve("done"));
      call += 1;
      return next();
    };
    const reads = vi.fn(read);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const hook = renderHook(
      () => ({
        bot: useQuery({ queryKey: ["bot", "b1"], queryFn: reads }),
        act: useFinancialMutation({
          mutationFn: send,
          refetch: [["bot", "b1"]],
          retryDelayMs: 0,
        }),
      }),
      { wrapper },
    );
    return { hook, keys, reads };
  }

  it("keeps the action locked while it reads the bot back after 409 unknown, then uses a new key", async () => {
    const backend = deferred<string>();
    let readCount = 0;
    const { hook, keys, reads } = setup([() => Promise.reject(conflict("unknown"))], () => {
      readCount += 1;
      return readCount === 1 ? Promise.resolve("running") : backend.promise;
    });
    await waitFor(() => {
      expect(hook.result.current.bot.data).toBe("running");
    });

    act(() => {
      hook.result.current.act.mutate("pause");
    });
    // Đang đọc lại bot: nút vẫn khoá (isPending) và báo đang kiểm tra.
    await waitFor(() => {
      expect(hook.result.current.act.checking).toBe(true);
    });
    expect(hook.result.current.act.isPending).toBe(true);
    expect(reads).toHaveBeenCalledTimes(2);
    // Không gửi lại tự động: server đã giữ key ở `failed_unknown`.
    expect(keys).toHaveLength(1);

    act(() => {
      backend.resolve("pausing");
    });
    await waitFor(() => {
      expect(hook.result.current.act.isPending).toBe(false);
    });
    expect(hook.result.current.act.checking).toBe(false);
    expect(hook.result.current.bot.data).toBe("pausing");
    expect(uncertainOutcome(hook.result.current.act.error)).toBe("unknown");

    // Bấm lại sau khi đã thấy trạng thái thật: key mới.
    await act(() => hook.result.current.act.mutateAsync("pause"));
    expect(keys).toHaveLength(2);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it("retries a network error once with the same key, then reads back and keeps that key for the next click", async () => {
    const { hook, keys, reads } = setup(
      [() => Promise.reject(network()), () => Promise.reject(network())],
      () => Promise.resolve("running"),
    );
    await waitFor(() => {
      expect(hook.result.current.bot.isSuccess).toBe(true);
    });
    await act(async () => {
      await hook.result.current.act.mutateAsync("stop").catch(() => undefined);
    });
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    expect(reads).toHaveBeenCalledTimes(2);
    expect(hook.result.current.act.isPending).toBe(false);

    // Request đầu có thể đã tới server: bấm lại cùng thao tác vẫn dùng key cũ (server phát lại kết quả).
    await act(() => hook.result.current.act.mutateAsync("stop"));
    expect(keys).toHaveLength(3);
    expect(keys[2]).toBe(keys[0]);
  });

  it("reads back after a 5xx and drops the key", async () => {
    const { hook, keys, reads } = setup([() => Promise.reject(serverError())], () =>
      Promise.resolve("running"),
    );
    await waitFor(() => {
      expect(hook.result.current.bot.isSuccess).toBe(true);
    });
    await act(async () => {
      await hook.result.current.act.mutateAsync("resume").catch(() => undefined);
    });
    expect(keys).toHaveLength(1);
    expect(reads).toHaveBeenCalledTimes(2);
    await act(() => hook.result.current.act.mutateAsync("resume"));
    expect(keys[1]).not.toBe(keys[0]);
  });

  it("does not read back or retry a known refusal", async () => {
    const { hook, keys, reads } = setup([() => Promise.reject(stateConflict())], () =>
      Promise.resolve("running"),
    );
    await waitFor(() => {
      expect(hook.result.current.bot.isSuccess).toBe(true);
    });
    await act(async () => {
      await hook.result.current.act.mutateAsync("start").catch(() => undefined);
    });
    expect(keys).toHaveLength(1);
    expect(reads).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(hook.result.current.act.error).toBeInstanceOf(ApiError);
    });
    expect(hook.result.current.act.checking).toBe(false);
  });
});
