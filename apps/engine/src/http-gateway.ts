import { postJson, type ClientTls } from "@drift/runtime";
import { DRIFT_BUILDER_FEE_RATE, dec, isBuilderAccount } from "@drift/shared";
import {
  MonotonicNonceSource,
  orderResultSchema,
  parseOrderResults,
  perpsCancelOrders,
  perpsModifyOrder,
  perpsNewOrders,
  perpsUpdateLeverage,
  readDriftApproval,
  SodexMarginMode,
  SodexOrderModifier,
  SodexOrderType,
  SodexSide,
  SodexStopType,
  SodexTimeInForce,
  SodexTriggerType,
  spotCancelOrders,
  spotNewOrders,
  type ActionPayload,
  type SignedWriteClient,
  type SodexRestClient,
} from "@drift/sodex";
import type { MarketRules, OrderIntent } from "@drift/strategies";
import type { Hex } from "viem";
import { z } from "zod";

import type {
  AccountRef,
  CancelResult,
  Fence,
  Gateway,
  LeverageResult,
  LeverageSetting,
  LookupResult,
  ModifyStopResult,
  NotSentCode,
  SubmitResult,
  OrderTrade,
} from "./gateway";

// Gateway thật: dựng payload lệnh (có `builder` của DRIFT, SODEX.md mục 5.3), xin signer ký kèm epoch,
// gửi một lần bằng SignedWriteClient. Kết quả từng lệnh khớp theo clOrdID; không rõ thì `unknown`.

/**
 * Bot paper không bao giờ được đi qua cổng thật (DEC-105): mọi phương thức kiểm tra cờ `paper` trước khi làm gì.
 * Ném lỗi thay vì trả `not_sent` để lỗi định tuyến lộ ra ngay, không bị coi như lỗi tạm thời.
 */
export class PaperRefusedError extends Error {
  constructor() {
    super("HttpGateway refuses paper bots");
  }
}
function refusePaper(account: AccountRef): void {
  if (account.paper === true) throw new PaperRefusedError();
}

/** Signer từ chối ký hoặc không gọi được: request chưa rời DRIFT. */
export class NotSentError extends Error {
  constructor(readonly code: NotSentCode) {
    super(`not sent: ${code}`);
  }
}

export interface SignerApi {
  sign(input: {
    apiKeyId: string;
    domain: "spot" | "futures";
    payloadHash: Hex;
    nonce: string;
    shard: number;
    epoch: number;
  }): Promise<Hex>;
}

export function httpSigner(baseUrl: string, tls?: ClientTls): SignerApi {
  const base = baseUrl.replace(/\/+$/, "");
  return {
    async sign(input) {
      // mTLS khi có cert (DEC-42): CN `engine` là caller duy nhất được ký lệnh.
      let res;
      try {
        res = await postJson(`${base}/v1/sign`, input, { tls, timeoutMs: 5000 });
      } catch {
        throw new NotSentError("signer_unavailable");
      }
      if (res.status === 422) throw new NotSentError("key_unusable");
      if (res.status === 404) throw new NotSentError("key_not_active");
      if (res.status === 409) throw new NotSentError("stale_epoch");
      if (res.status !== 200) throw new NotSentError("signer_unavailable");
      return z.object({ signature: z.string().regex(/^0x01[0-9a-f]{130}$/i) }).parse(res.json)
        .signature as Hex;
    },
  };
}

export interface MarketInfo extends MarketRules {
  id: bigint;
  engine: "spot" | "perps";
}

/** Thư mục market (id + quy tắc), đọc từ market info SoDEX có cache (SodexRestClient). */
export async function marketInfo(
  rest: SodexRestClient,
  market: string,
): Promise<MarketInfo | undefined> {
  const [spot, perps] = await Promise.all([rest.getSpotSymbols(), rest.getPerpsSymbols()]);
  const s = spot.find((x) => x.name === market);
  if (s !== undefined)
    return {
      id: s.id,
      engine: "spot",
      tickSize: s.tickSize,
      stepSize: s.stepSize,
      minQuantity: s.minQuantity,
      minNotional: s.minNotional,
      ...fees(s),
    };
  const p = perps.find((x) => x.name === market);
  if (p !== undefined)
    return {
      id: p.id,
      engine: "perps",
      tickSize: p.tickSize,
      stepSize: p.stepSize,
      minQuantity: p.minQuantity,
      minNotional: p.minNotional,
      ...fees(p),
    };
  return undefined;
}

const fees = (x: { makerFee?: string | undefined; takerFee?: string | undefined }) => ({
  ...(x.makerFee === undefined ? {} : { makerFee: x.makerFee }),
  ...(x.takerFee === undefined ? {} : { takerFee: x.takerFee }),
});

const side = (s: "buy" | "sell") => (s === "buy" ? SodexSide.buy : SodexSide.sell);
const tif = (t: OrderIntent["timeInForce"]) =>
  t === "GTC" ? SodexTimeInForce.gtc : t === "IOC" ? SodexTimeInForce.ioc : SodexTimeInForce.gtx;

export class HttpGateway implements Gateway {
  readonly #nonces = new MonotonicNonceSource();

  constructor(
    private readonly rest: SodexRestClient,
    private readonly writer: SignedWriteClient,
    private readonly signer: SignerApi,
    private readonly builderId: bigint,
    /** Account builder được miễn builder fee (DEC-47); false = gắn builder fee như mọi account (DEC-124). */
    private readonly builderExempt = true,
  ) {}

  async #send(
    account: AccountRef,
    payload: ActionPayload,
    method: "POST" | "DELETE",
    fence: Fence,
    count: number,
  ) {
    const nonce = this.#nonces.next(account.address);
    // Lỗi ở bước ký: request chưa rời DRIFT → NotSentError (không phải `unknown`).
    const signature = await this.signer
      .sign({
        apiKeyId: account.apiKeyId,
        domain: payload.domain,
        payloadHash: payload.payloadHash,
        nonce: nonce.toString(),
        shard: fence.shard,
        epoch: fence.epoch,
      })
      .catch((error: unknown) => {
        throw error instanceof NotSentError ? error : new NotSentError("signer_unavailable");
      });
    const path =
      payload.type === "batchNewOrder" || payload.type === "batchCancelOrder"
        ? "/spot/trade/orders/batch"
        : payload.type === "updateLeverage"
          ? "/perps/trade/leverage"
          : payload.type === "modifyOrder"
            ? "/perps/trade/orders/modify"
            : "/perps/trade/orders";
    return this.writer.write({
      path,
      method,
      body: payload.body,
      signature,
      nonce,
      apiKeyName: account.apiKeyName,
      orderCount: count,
    });
  }

  async submit(
    account: AccountRef,
    list: readonly OrderIntent[],
    fence: Fence,
    builderFeeRate = DRIFT_BUILDER_FEE_RATE,
  ): Promise<SubmitResult[]> {
    refusePaper(account);
    const out: SubmitResult[] = [];
    // Account của chính builder: không gắn builder fee (không tự thu phí của mình, DEC-47).
    const builder = isBuilderAccount(account.sodexAccountId, this.builderId, this.builderExempt)
      ? undefined
      : { id: this.builderId, fee: Math.min(builderFeeRate, DRIFT_BUILDER_FEE_RATE) };
    // Perps: mỗi request một symbol. Spot: một batch nhiều symbol.
    const groups = new Map<string, OrderIntent[]>();
    for (const o of list) {
      const key = o.engine === "spot" ? "spot" : `perps:${o.market}`;
      groups.set(key, [...(groups.get(key) ?? []), o]);
    }
    for (const [key, group] of groups) {
      const infos = await Promise.all(group.map((o) => marketInfo(this.rest, o.market)));
      let payload: ActionPayload;
      if (key === "spot") {
        payload = spotNewOrders({
          accountID: account.sodexAccountId,
          orders: group.map((o, i) => ({
            symbolID: infos[i]?.id ?? 0n,
            clOrdID: o.clOrdID,
            side: side(o.side),
            type: o.type === "limit" ? SodexOrderType.limit : SodexOrderType.market,
            timeInForce: tif(o.timeInForce),
            ...(o.price === undefined ? {} : { price: o.price }),
            quantity: o.quantity,
          })),
          ...(builder === undefined ? {} : { builder }),
        });
      } else {
        payload = perpsNewOrders({
          accountID: account.sodexAccountId,
          symbolID: infos[0]?.id ?? 0n,
          orders: group.map((o) =>
            o.stop === undefined
              ? {
                  clOrdID: o.clOrdID,
                  modifier: SodexOrderModifier.normal,
                  side: side(o.side),
                  type: o.type === "limit" ? SodexOrderType.limit : SodexOrderType.market,
                  timeInForce: tif(o.timeInForce),
                  ...(o.price === undefined ? {} : { price: o.price }),
                  quantity: o.quantity,
                  reduceOnly: o.reduceOnly,
                }
              : {
                  // Stop loss của vị thế (DEC-118): không gửi quantity → SoDEX đóng cả vị thế lúc kích hoạt.
                  clOrdID: o.clOrdID,
                  modifier: SodexOrderModifier.stop,
                  side: side(o.side),
                  type: SodexOrderType.market,
                  timeInForce: SodexTimeInForce.ioc,
                  stopPrice: o.stop.price,
                  stopType: SodexStopType.stopLoss,
                  triggerType: SodexTriggerType.markPrice,
                  reduceOnly: true,
                },
          ),
          ...(builder === undefined ? {} : { builder }),
        });
      }
      let result;
      try {
        result = await this.#send(account, payload, "POST", fence, group.length);
      } catch (error) {
        // Lỗi trước khi gửi (signer): lệnh chưa rời DRIFT → `not_sent`. Lỗi khác trong lúc gửi → `unknown`.
        out.push(
          ...group.map((o): SubmitResult =>
            error instanceof NotSentError
              ? { clOrdID: o.clOrdID, outcome: "not_sent", code: error.code }
              : { clOrdID: o.clOrdID, outcome: "unknown" },
          ),
        );
        continue;
      }
      if (result.outcome === "unknown") {
        out.push(...group.map((o): SubmitResult => ({ clOrdID: o.clOrdID, outcome: "unknown" })));
      } else if (result.outcome === "rejected") {
        out.push(
          ...group.map((o): SubmitResult => ({
            clOrdID: o.clOrdID,
            outcome: "rejected",
            code: String(result.sodexCode),
            message: rejectMessage(result.sodexError),
          })),
        );
      } else {
        const items = parseOrderResults(result.data);
        for (const o of group) {
          // Lỗi pre-validation có thể chỉ trả một phần tử cho cả batch: khớp theo clOrdID, không giả định độ dài.
          const item =
            items.find((x) => x.clOrdID === o.clOrdID) ??
            (items.length === 1 ? items[0] : undefined);
          if (item === undefined) out.push({ clOrdID: o.clOrdID, outcome: "unknown" });
          else if (item.code === 0 && item.orderID !== undefined)
            out.push({ clOrdID: o.clOrdID, outcome: "ok", orderId: item.orderID });
          else
            out.push({
              clOrdID: o.clOrdID,
              outcome: "rejected",
              code: String(item.code),
              message: rejectMessage(item.error),
            });
        }
      }
    }
    return out;
  }

  async setLeverage(
    account: AccountRef,
    input: { market: string; leverage: number; marginMode: "cross" | "isolated" },
    fence: Fence,
  ): Promise<LeverageResult> {
    refusePaper(account);
    const info = await marketInfo(this.rest, input.market);
    if (info?.engine !== "perps") return { outcome: "rejected", code: "MARKET_NOT_FOUND" };
    const payload = perpsUpdateLeverage({
      accountID: account.sodexAccountId,
      symbolID: info.id,
      leverage: input.leverage,
      marginMode:
        input.marginMode === "isolated" ? SodexMarginMode.isolated : SodexMarginMode.cross,
    });
    try {
      // Endpoint không có payload khi thành công (Go SDK README); chỉ cần outcome.
      const result = await this.#send(account, payload, "POST", fence, 1);
      return result.outcome === "rejected"
        ? { outcome: "rejected", code: String(result.sodexCode) }
        : result.outcome === "unknown"
          ? { outcome: "unknown" }
          : { outcome: "ok" };
    } catch (error) {
      return error instanceof NotSentError
        ? { outcome: "not_sent", code: error.code }
        : { outcome: "unknown" };
    }
  }

  async readLeverage(
    account: AccountRef,
    market: string,
  ): Promise<{ setting: LeverageSetting | null; position: LeverageSetting | null }> {
    refusePaper(account);
    const state = await this.rest.getPerpsAccountState(account.address);
    const s = state.S.find((x) => x.s === market);
    const p = state.P.find((x) => x.s === market && Number(x.sz) !== 0);
    const mode = (m: string): "cross" | "isolated" =>
      m.toUpperCase() === "ISOLATED" ? "isolated" : "cross";
    return {
      setting: s === undefined ? null : { leverage: s.l, marginMode: mode(s.m) },
      position: p === undefined ? null : { leverage: p.l, marginMode: mode(p.m) },
    };
  }

  async cancel(
    account: AccountRef,
    list: readonly { clOrdID: string; market: string; engine: "spot" | "perps" }[],
    fence: Fence,
  ): Promise<CancelResult[]> {
    refusePaper(account);
    const out: CancelResult[] = [];
    for (const o of list) {
      const info = await marketInfo(this.rest, o.market);
      if (info === undefined) {
        out.push({ clOrdID: o.clOrdID, outcome: "unknown" });
        continue;
      }
      const payload =
        o.engine === "spot"
          ? spotCancelOrders({
              accountID: account.sodexAccountId,
              cancels: [
                {
                  symbolID: info.id,
                  clOrdID: `${o.clOrdID.slice(0, 30)}-c`,
                  origClOrdID: o.clOrdID,
                },
              ],
            })
          : perpsCancelOrders({
              accountID: account.sodexAccountId,
              cancels: [{ symbolID: info.id, clOrdID: o.clOrdID }],
            });
      // Chưa rời DRIFT (signer lỗi) thì vẫn ném NotSentError như trước: caller không đặt lệnh mới.
      const res = await this.#send(account, payload, "DELETE", fence, 1);
      if (res.outcome === "rejected") {
        out.push({ clOrdID: o.clOrdID, outcome: "rejected", code: String(res.sodexCode) });
      } else if (res.outcome === "unknown") {
        out.push({
          clOrdID: o.clOrdID,
          outcome: "unknown",
          ...(res.detail === undefined ? {} : { detail: res.detail }),
        });
      } else {
        // Envelope ok nhưng từng lệnh vẫn có `code` riêng; đọc không được thì coi như chưa rõ.
        const parsed = z.array(orderResultSchema).safeParse(res.data);
        const item = parsed.success ? parsed.data[0] : undefined;
        out.push(
          item === undefined
            ? {
                clOrdID: o.clOrdID,
                outcome: "unknown",
                detail: `ok envelope, unreadable result: ${JSON.stringify(res.data).slice(0, 300)}`,
              }
            : item.code === 0
              ? { clOrdID: o.clOrdID, outcome: "ok" }
              : { clOrdID: o.clOrdID, outcome: "rejected", code: String(item.code) },
        );
      }
    }
    return out;
  }

  async modifyStop(
    account: AccountRef,
    o: { clOrdID: string; market: string; stopPrice: string },
    fence: Fence,
  ): Promise<ModifyStopResult> {
    refusePaper(account);
    const info = await marketInfo(this.rest, o.market);
    if (info === undefined) return { outcome: "unknown" };
    const payload = perpsModifyOrder({
      accountID: account.sodexAccountId,
      symbolID: info.id,
      clOrdID: o.clOrdID,
      stopPrice: o.stopPrice,
    });
    let res;
    try {
      res = await this.#send(account, payload, "POST", fence, 1);
    } catch (error) {
      if (error instanceof NotSentError) return { outcome: "not_sent", code: error.code };
      return { outcome: "unknown" };
    }
    if (res.outcome === "rejected") return { outcome: "rejected", code: String(res.sodexCode) };
    if (res.outcome === "unknown") return { outcome: "unknown" };
    // Envelope ok; một số endpoint trả kết quả từng lệnh kèm `code` riêng.
    const parsed = z.array(orderResultSchema).safeParse(res.data);
    const item = parsed.success ? parsed.data[0] : undefined;
    return item !== undefined && item.code !== 0
      ? { outcome: "rejected", code: String(item.code) }
      : { outcome: "ok" };
  }

  async recentTrades(
    account: AccountRef,
    q: { market: string; engine: "spot" | "perps" },
  ): Promise<(OrderTrade & { clOrdID: string })[]> {
    refusePaper(account);
    const rows = await this.rest.getTrades(q.engine, account.address, {
      accountID: account.sodexAccountId,
      symbol: q.market,
      limit: 500,
    });
    return rows.map((t) => ({
      clOrdID: t.clOrdID,
      tradeId: t.tradeID,
      price: t.price,
      quantity: t.quantity,
      fee: t.fee ?? "0",
      builderFee: t.builderFee ?? null,
      isMaker: t.isMaker ?? false,
      at: t.time,
    }));
  }

  async readPosition(
    account: AccountRef,
    market: string,
  ): Promise<{ size: string; entryPrice: string } | null> {
    refusePaper(account);
    const state = await this.rest.getPerpsAccountState(account.address);
    const p = state.P.find((x) => x.s === market && !dec(x.sz).isZero());
    return p === undefined ? null : { size: p.sz, entryPrice: p.ep };
  }

  async tradesOf(
    account: AccountRef,
    o: { clOrdID: string; market: string; engine: "spot" | "perps" },
  ): Promise<OrderTrade[]> {
    refusePaper(account);
    const rows = await this.rest.getTrades(o.engine, account.address, {
      accountID: account.sodexAccountId,
      symbol: o.market,
      limit: 500,
    });
    return rows
      .filter((t) => t.clOrdID === o.clOrdID)
      .map((t) => ({
        tradeId: t.tradeID,
        price: t.price,
        quantity: t.quantity,
        fee: t.fee ?? "0",
        builderFee: t.builderFee ?? null,
        isMaker: t.isMaker ?? false,
        at: t.time,
      }));
  }

  async lookup(
    account: AccountRef,
    o: { clOrdID: string; market: string; engine: "spot" | "perps" },
  ): Promise<LookupResult> {
    refusePaper(account);
    const q = { accountID: account.sodexAccountId, symbol: o.market };
    const open = (await this.rest.getOpenOrders(o.engine, account.address, q)).find(
      (x) => x.clOrdID === o.clOrdID,
    );
    const found =
      open ??
      (await this.rest.getOrderHistory(o.engine, account.address, { ...q, limit: 500 })).find(
        (x) => x.clOrdID === o.clOrdID,
      );
    if (found === undefined) return { status: "not_found" };
    const status =
      found.status === "NEW"
        ? "open"
        : // Stop loss đã kích hoạt (DEC-118): còn sống cho tới khi lệnh market sinh ra khớp xong.
          found.status === "TRIGGERED"
          ? dec(found.executedQty).gt(0)
            ? "filled"
            : "open"
          : found.status === "PARTIALLY_FILLED"
            ? "partially_filled"
            : found.status === "FILLED"
              ? "filled"
              : found.status === "REJECTED"
                ? "rejected"
                : "cancelled";
    const avg = dec(found.executedQty).gt(0)
      ? dec(found.executedValue).div(found.executedQty).toString()
      : null;
    return { status, filledQty: found.executedQty, avgPrice: avg, orderId: found.orderID };
  }

  async builderApproved(account: AccountRef): Promise<boolean> {
    refusePaper(account);
    if (isBuilderAccount(account.sodexAccountId, this.builderId, this.builderExempt)) return true;
    return readDriftApproval(await this.rest.getBuilderApprovals(account.address), this.builderId)
      .approved;
  }
}

/** Câu lỗi SoDEX để lưu và hiện cho người dùng: bỏ khoảng trắng thừa, tối đa 300 ký tự. */
export function rejectMessage(text: string | undefined): string | null {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  return t === "" ? null : t.slice(0, 300);
}
