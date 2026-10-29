import { readFileSync } from "node:fs";

import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  SodexMarginMode,
  SodexOrderModifier,
  SodexOrderType,
  SodexSide,
  SodexTimeInForce,
} from "../actions/enums";
import {
  perpsCancelOrders,
  perpsNewOrders,
  perpsUpdateLeverage,
  spotCancelOrders,
  spotNewOrders,
  type ActionPayload,
} from "../actions/orders";
import { signExchangeAction } from "../signing/exchange";

// Golden vector chữ ký giao dịch, sinh từ Go SDK chính thức (DEC-27). Chương trình sinh nằm cạnh
// fixture (`go-sdk-exchange-vectors.go.txt`). Khoá 0x2222…2222 là khoá test công khai.

const fixtureSchema = z.object({
  privateKey: z.string().regex(/^0x[0-9a-f]{64}$/),
  address: z.string(),
  vectors: z.array(
    z.object({
      name: z.string(),
      domain: z.enum(["spot", "futures"]),
      payload: z.string(),
      payloadHash: z.string(),
      signature: z.string(),
      nonce: z.number().int(),
    }),
  ),
});

const fixture = fixtureSchema.parse(
  JSON.parse(
    readFileSync(new URL("./fixtures/go-sdk-exchange-vectors.json", import.meta.url), "utf8"),
  ),
);
const account = privateKeyToAccount(fixture.privateKey as Hex);
const builder = { id: 1645n, fee: 50 };

const payloads: Record<string, ActionPayload> = {
  perpsNewOrderDocs: perpsNewOrders({
    accountID: 12345n,
    symbolID: 1n,
    orders: [
      {
        clOrdID: "my-order-1",
        modifier: SodexOrderModifier.normal,
        side: SodexSide.buy,
        type: SodexOrderType.market,
        timeInForce: SodexTimeInForce.ioc,
        quantity: "0.001",
        reduceOnly: false,
      },
    ],
  }),
  perpsNewOrderBuilder: perpsNewOrders({
    accountID: 1645n,
    symbolID: 2n,
    orders: [
      {
        clOrdID: "drift-b1-v3-l2-a0",
        modifier: SodexOrderModifier.normal,
        side: SodexSide.sell,
        type: SodexOrderType.limit,
        timeInForce: SodexTimeInForce.gtx,
        price: "65000.10",
        quantity: "0.0100",
        reduceOnly: true,
      },
    ],
    builder,
  }),
  perpsCancel: perpsCancelOrders({
    accountID: 1645n,
    cancels: [
      { symbolID: 2n, clOrdID: "drift-b1-v3-l2-a0" },
      { symbolID: 2n, orderID: 18446744073709551615n },
    ],
  }),
  spotNewOrderBuilder: spotNewOrders({
    accountID: 1645n,
    orders: [
      {
        symbolID: 7n,
        clOrdID: "drift-grid-1",
        side: SodexSide.buy,
        type: SodexOrderType.limit,
        timeInForce: SodexTimeInForce.gtc,
        price: "3511.60",
        quantity: "0.0268",
      },
    ],
    builder,
  }),
  spotCancel: spotCancelOrders({
    accountID: 1645n,
    cancels: [{ symbolID: 7n, clOrdID: "drift-cx-1", origClOrdID: "drift-grid-1" }],
  }),
};

describe("exchange signing matches the official Go SDK (contract)", () => {
  it("uses the documented test key", () => {
    expect(account.address).toBe(fixture.address);
  });

  it("covers every vector", () => {
    expect(Object.keys(payloads).sort()).toEqual(fixture.vectors.map((v) => v.name).sort());
  });

  for (const vector of fixture.vectors) {
    it(`${vector.name}: payload, hash and signature`, async () => {
      const payload = payloads[vector.name];
      if (payload === undefined) throw new Error(`No payload for ${vector.name}`);
      expect(payload.domain).toBe(vector.domain);
      expect(`{"type":"${payload.type}","params":${payload.body}}`).toBe(vector.payload);
      expect(payload.payloadHash).toBe(vector.payloadHash);
      const signature = await signExchangeAction(
        account,
        payload.domain,
        payload.payloadHash,
        BigInt(vector.nonce),
      );
      expect(signature).toBe(vector.signature);
    });
  }
});

describe("updateLeverage payload (contract)", () => {
  // Chưa có golden vector Go SDK cho action này: so với JSON mẫu `POST /api/v1/perps/trade/leverage`
  // trong `references/trading.md` của sodex-go-sdk-public và thứ tự field của `UpdateLeverageRequest`.
  it("matches the SDK example byte for byte, on the futures domain", () => {
    const payload = perpsUpdateLeverage({
      accountID: 43933n,
      symbolID: 1n,
      leverage: 10,
      marginMode: SodexMarginMode.isolated,
    });
    expect(payload.type).toBe("updateLeverage");
    expect(payload.domain).toBe("futures");
    expect(payload.body).toBe('{"accountID":43933,"symbolID":1,"leverage":10,"marginMode":1}');
  });

  it("refuses a non-integer or zero leverage", () => {
    const base = { accountID: 1n, symbolID: 1n, marginMode: SodexMarginMode.cross };
    expect(() => perpsUpdateLeverage({ ...base, leverage: 0 })).toThrow(RangeError);
    expect(() => perpsUpdateLeverage({ ...base, leverage: 2.5 })).toThrow(RangeError);
  });
});
