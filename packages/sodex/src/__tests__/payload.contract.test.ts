import { keccak256, recoverTypedDataAddress, stringToBytes, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import { SodexOrderModifier, SodexOrderType, SodexSide, SodexTimeInForce } from "../actions/enums";
import {
  perpsCancelOrders,
  perpsNewOrders,
  spotCancelOrders,
  spotNewOrders,
} from "../actions/orders";
import { exchangeDomain, exchangeTypes, signExchangeAction } from "../signing/exchange";

// Ví dụ payload trong trang "Authentication and signing" của SoDEX, chép nguyên văn.
const DOCS_SIGNING_PAYLOAD =
  '{"type":"newOrder","params":{"accountID":12345,"symbolID":1,"orders":[{"clOrdID":"my-order-1","modifier":1,"side":1,"type":2,"timeInForce":3,"quantity":"0.001","reduceOnly":false,"positionSide":1}]}}';

const docsOrder = {
  clOrdID: "my-order-1",
  modifier: SodexOrderModifier.normal,
  side: SodexSide.buy,
  type: SodexOrderType.market,
  timeInForce: SodexTimeInForce.ioc,
  quantity: "0.001",
  reduceOnly: false,
};

describe("payload hashing (contract)", () => {
  it("serializes a perps newOrder exactly like the SoDEX docs example", () => {
    const payload = perpsNewOrders({ accountID: 12345n, symbolID: 1n, orders: [docsOrder] });
    const params = DOCS_SIGNING_PAYLOAD.slice('{"type":"newOrder","params":'.length, -1);
    expect(payload.type).toBe("newOrder");
    expect(payload.domain).toBe("futures");
    expect(payload.body).toBe(params);
    expect(payload.payloadHash).toBe(keccak256(stringToBytes(DOCS_SIGNING_PAYLOAD)));
  });

  it("puts builder last with id before fee, after orders, on perps", () => {
    const payload = perpsNewOrders({
      accountID: 1n,
      symbolID: 2n,
      orders: [
        {
          ...docsOrder,
          type: SodexOrderType.limit,
          timeInForce: SodexTimeInForce.gtx,
          price: "65000.10",
        },
      ],
      builder: { id: 18446744073709551615n, fee: 50 },
    });
    expect(payload.body).toBe(
      '{"accountID":1,"symbolID":2,"orders":[{"clOrdID":"my-order-1","modifier":1,"side":1,"type":1,"timeInForce":4,"price":"65000.1","quantity":"0.001","reduceOnly":false,"positionSide":1}],"builder":{"id":18446744073709551615,"fee":50}}',
    );
  });

  it("puts builder at batch level after orders on spot and uses batchNewOrder", () => {
    const payload = spotNewOrders({
      accountID: 1010n,
      orders: [
        {
          symbolID: 3n,
          clOrdID: "drift-1",
          side: SodexSide.sell,
          type: SodexOrderType.limit,
          timeInForce: SodexTimeInForce.gtc,
          price: "0.0100",
          quantity: "1.0",
        },
      ],
      builder: { id: 7n, fee: 50 },
    });
    expect(payload.type).toBe("batchNewOrder");
    expect(payload.domain).toBe("spot");
    expect(payload.body).toBe(
      '{"accountID":1010,"orders":[{"symbolID":3,"clOrdID":"drift-1","side":2,"type":1,"timeInForce":1,"price":"0.01","quantity":"1"}],"builder":{"id":7,"fee":50}}',
    );
  });

  it("omits optional fields and keeps required false values", () => {
    const payload = perpsNewOrders({ accountID: 1n, symbolID: 1n, orders: [docsOrder] });
    expect(payload.body).not.toContain("price");
    expect(payload.body).not.toContain("builder");
    expect(payload.body).toContain('"reduceOnly":false');
  });

  it("builds cancels in SoDEX field order", () => {
    expect(
      spotCancelOrders({
        accountID: 1n,
        cancels: [{ symbolID: 3n, clOrdID: "cancel-1", orderID: 99n }],
      }).body,
    ).toBe('{"accountID":1,"cancels":[{"symbolID":3,"clOrdID":"cancel-1","orderID":99}]}');
    expect(
      perpsCancelOrders({ accountID: 1n, cancels: [{ symbolID: 2n, clOrdID: "drift-1" }] }).body,
    ).toBe('{"accountID":1,"cancels":[{"symbolID":2,"clOrdID":"drift-1"}]}');
  });

  it("rejects invalid clOrdIDs, empty or oversized batches, and number-like decimals", () => {
    expect(() =>
      perpsNewOrders({
        accountID: 1n,
        symbolID: 1n,
        orders: [{ ...docsOrder, clOrdID: "bad id" }],
      }),
    ).toThrow(RangeError);
    expect(() => perpsNewOrders({ accountID: 1n, symbolID: 1n, orders: [] })).toThrow(RangeError);
    expect(() =>
      perpsNewOrders({
        accountID: 1n,
        symbolID: 1n,
        orders: Array.from({ length: 101 }, (_, i) => ({
          ...docsOrder,
          clOrdID: `o-${String(i)}`,
        })),
      }),
    ).toThrow(RangeError);
    expect(() =>
      perpsNewOrders({ accountID: 1n, symbolID: 1n, orders: [{ ...docsOrder, quantity: "1e-3" }] }),
    ).toThrow(RangeError);
    expect(() =>
      spotCancelOrders({ accountID: 1n, cancels: [{ symbolID: 1n, clOrdID: "c-1" }] }),
    ).toThrow(RangeError);
  });
});

describe("exchange action signing", () => {
  // Khoá test công khai trong ví dụ của tài liệu SoDEX, không phải tài sản thật.
  const account = privateKeyToAccount(
    "0x2222222222222222222222222222222222222222222222222222222222222222",
  );

  // Tài liệu SoDEX ghi địa chỉ 0x3d45…8256 cho khoá này, nhưng địa chỉ thật là 0x1563…5508.
  // Ví dụ đó tự mâu thuẫn nên không dùng payload hash 0x7521… của nó (docs/SODEX.md mục 5.5).
  it("derives the real address of the docs test key", () => {
    expect(account.address).toBe("0x1563915e194D8CfBA1943570603F7606A3115508");
  });

  it("signs ExchangeAction with prefix 0x01 and recovers to the signer", async () => {
    const payload = perpsNewOrders({ accountID: 12345n, symbolID: 1n, orders: [docsOrder] });
    const nonce = 1760373925001n;
    const sodexSig = await signExchangeAction(account, "futures", payload.payloadHash, nonce);
    expect(sodexSig).toMatch(/^0x01[0-9a-f]{128}0[01]$/);

    const v = parseInt(sodexSig.slice(-2), 16) + 27;
    const ethSig: Hex = `0x${sodexSig.slice(4, 132)}${v.toString(16)}`;
    const recovered = await recoverTypedDataAddress({
      domain: exchangeDomain("futures"),
      types: exchangeTypes,
      primaryType: "ExchangeAction",
      message: { payloadHash: payload.payloadHash, nonce },
      signature: ethSig,
    });
    expect(recovered).toBe(account.address);
  });
});
