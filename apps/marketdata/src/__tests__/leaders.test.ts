import type { LeaderFillMessage, LeaderPositionMessage } from "@drift/shared";
import { describe, expect, it } from "vitest";

import { LeaderBook, LeaderWatcher, type LeaderTrade } from "../leaders";

const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const trade = (side: "buy" | "sell", quantity: string, market = "BTC-USD"): LeaderTrade => ({
  market,
  side,
  price: "100000",
  quantity,
  at: 1,
});

describe("LeaderBook", () => {
  it("cộng dồn fill lên mốc REST, có dấu", () => {
    const b = new LeaderBook();
    b.reset(A, { "BTC-USD": "1", "ETH-USD": "0" });
    expect(b.apply(A, trade("buy", "0.5"))).toBe("1.5");
    expect(b.apply(A, trade("sell", "2.5"))).toBe("-1");
    expect(b.apply(A, trade("buy", "1"))).toBe("0");
    expect(b.positions(A)).toEqual({});
  });
});

function harness(
  leaders: string[],
  positions: Record<string, Record<string, string>>,
  maxStreams = 8,
) {
  const published: { subject: string; payload: LeaderFillMessage | LeaderPositionMessage }[] = [];
  const handlers = new Map<string, { onTrades(t: LeaderTrade[]): void; onReconnect(): void }>();
  const closed: string[] = [];
  const w = new LeaderWatcher({
    activeLeaders: () => Promise.resolve(leaders),
    readPositions: (a) => Promise.resolve(positions[a] ?? {}),
    openStream: (a, h) => {
      handlers.set(a, h);
      return { close: () => closed.push(a) };
    },
    publish: (subject, payload) => published.push({ subject, payload }),
    now: () => 42,
    warn: () => undefined,
    maxStreams,
  });
  return { w, published, handlers, closed };
}

describe("LeaderWatcher", () => {
  it("mở stream, publish vị thế mốc, rồi fill kèm vị thế sau fill", async () => {
    const h = harness([A], { [A]: { "BTC-USD": "2" } });
    await h.w.sync();
    expect(h.published[0]).toEqual({
      subject: `leader.sodex.${A}.position`,
      payload: { source: "sodex", address: A, positions: { "BTC-USD": "2" }, at: 42 },
    });
    h.handlers.get(A)?.onTrades([trade("sell", "2")]);
    expect(h.published[1]?.subject).toBe(`leader.sodex.${A}.fill`);
    expect(h.published[1]?.payload).toMatchObject({ side: "sell", positionAfter: "0" });
  });

  it("đóng stream của ví không còn bot copy", async () => {
    const leaders = [A, B];
    const h = harness(leaders, {});
    await h.w.sync();
    leaders.splice(1, 1);
    await h.w.sync();
    expect(h.closed).toEqual([B]);
  });

  it("giữ dưới giới hạn WS của SoDEX: ví vượt mức chỉ được đọc vị thế", async () => {
    const h = harness([A, B], { [B]: { "BTC-USD": "1" } }, 1);
    await h.w.sync();
    expect([...h.handlers.keys()]).toEqual([A]);
    expect(h.published.map((p) => p.subject)).toContain(`leader.sodex.${B}.position`);
  });
});
