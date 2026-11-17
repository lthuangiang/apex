import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import { addPermissionedApiKeyRequest, approveBuilderFeeRequest } from "../actions/account";
import {
  SodexMarginMode,
  SodexOrderModifier,
  SodexOrderType,
  SodexSide,
  SodexTimeInForce,
} from "../actions/enums";
import {
  perpsCancelOrders,
  perpsModifyOrder,
  perpsNewOrders,
  perpsUpdateLeverage,
  spotCancelOrders,
  spotNewOrders,
} from "../actions/orders";
import { revokeApiKeyRequest } from "../actions/revoke-key";
import type { SodexCallCapture } from "../debug/capture";
import { toSodexCallRow } from "../debug/classify";
import { REDACTED, redactBody, redactHeaders } from "../debug/redact";
import { MemoryRateLimitStore } from "../rate-limit/token-bucket";
import { SignedWriteClient, type SignedWriteRequest } from "../rest/signed-write";
import { SignaturePrefix } from "../signing/chain";
import { exchangeDomain, exchangeTypes, ExchangeDomain } from "../signing/exchange";
import { toSodexSignature } from "../signing/signature";
import { signUniversal } from "../signing/universal";

// SoDEX Debugger (DEC-TBD-sodex-debugger): params của action đã ký được lưu, chữ ký / secret / header xác thực thì
// không bao giờ. Mỗi loại action đã ký đi qua SignedWriteClient thật với chữ ký thật, rồi kiểm bản ghi sẽ lưu.

const KEY = privateKeyToAccount(
  "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318",
);
const USER = KEY.address;
const KEY_NAME = "DeskLabs-20261117";
const NONCE = 1763391912468n;

async function exchangeSig(domain: ExchangeDomain, payloadHash: `0x${string}`) {
  const sig = await KEY.signTypedData({
    domain: exchangeDomain(domain),
    types: exchangeTypes,
    primaryType: "ExchangeAction",
    message: { payloadHash, nonce: NONCE },
  });
  return toSodexSignature(sig, SignaturePrefix.exchange);
}

interface Case {
  name: string;
  request: () => Promise<SignedWriteRequest>;
}

const builder = { id: 1645n, fee: 10 };

const CASES: Case[] = [
  {
    name: "spot batchNewOrder",
    request: async () => {
      const p = spotNewOrders({
        accountID: 20417n,
        orders: [
          {
            symbolID: 1n,
            clOrdID: "drift-b1-v1-a",
            side: SodexSide.buy,
            type: SodexOrderType.limit,
            timeInForce: SodexTimeInForce.gtc,
            price: "1.5",
            quantity: "2",
          },
        ],
        builder,
      });
      return {
        path: "/spot/trade/orders/batch",
        method: "POST",
        body: p.body,
        signature: await exchangeSig(p.domain, p.payloadHash),
        nonce: NONCE,
        apiKeyName: KEY_NAME,
        orderCount: 1,
        actionType: p.type,
      };
    },
  },
  {
    name: "spot batchCancelOrder",
    request: async () => {
      const p = spotCancelOrders({
        accountID: 20417n,
        cancels: [{ symbolID: 1n, clOrdID: "drift-b1-v1-c", origClOrdID: "drift-b1-v1-a" }],
      });
      return {
        path: "/spot/trade/orders/batch",
        method: "DELETE",
        body: p.body,
        signature: await exchangeSig(p.domain, p.payloadHash),
        nonce: NONCE,
        apiKeyName: KEY_NAME,
        orderCount: 1,
        actionType: p.type,
      };
    },
  },
  {
    name: "perps newOrder",
    request: async () => {
      const p = perpsNewOrders({
        accountID: 20417n,
        symbolID: 2n,
        orders: [
          {
            clOrdID: "drift-b2-v1-a",
            modifier: SodexOrderModifier.normal,
            side: SodexSide.sell,
            type: SodexOrderType.limit,
            timeInForce: SodexTimeInForce.gtx,
            price: "100",
            quantity: "0.1",
            reduceOnly: false,
          },
        ],
        builder,
      });
      return {
        path: "/perps/trade/orders",
        method: "POST",
        body: p.body,
        signature: await exchangeSig(p.domain, p.payloadHash),
        nonce: NONCE,
        apiKeyName: KEY_NAME,
        orderCount: 1,
        actionType: p.type,
      };
    },
  },
  {
    name: "perps cancelOrder",
    request: async () => {
      const p = perpsCancelOrders({
        accountID: 20417n,
        cancels: [{ symbolID: 2n, clOrdID: "drift-b2-v1-a" }],
      });
      return {
        path: "/perps/trade/orders",
        method: "DELETE",
        body: p.body,
        signature: await exchangeSig(p.domain, p.payloadHash),
        nonce: NONCE,
        apiKeyName: KEY_NAME,
        orderCount: 1,
        actionType: p.type,
      };
    },
  },
  {
    name: "perps modifyOrder",
    request: async () => {
      const p = perpsModifyOrder({
        accountID: 20417n,
        symbolID: 2n,
        clOrdID: "drift-b2-v1-s",
        stopPrice: "90",
      });
      return {
        path: "/perps/trade/orders/modify",
        method: "POST",
        body: p.body,
        signature: await exchangeSig(p.domain, p.payloadHash),
        nonce: NONCE,
        apiKeyName: KEY_NAME,
        orderCount: 1,
        actionType: p.type,
      };
    },
  },
  {
    name: "perps updateLeverage",
    request: async () => {
      const p = perpsUpdateLeverage({
        accountID: 20417n,
        symbolID: 2n,
        leverage: 3,
        marginMode: SodexMarginMode.cross,
      });
      return {
        path: "/perps/trade/leverage",
        method: "POST",
        body: p.body,
        signature: await exchangeSig(p.domain, p.payloadHash),
        nonce: NONCE,
        apiKeyName: KEY_NAME,
        orderCount: 1,
        actionType: p.type,
      };
    },
  },
  {
    name: "UserSignedAddPermissionedAPIKeyAction",
    request: async () => {
      const r = addPermissionedApiKeyRequest({
        user: USER,
        accountID: 20417n,
        publicKey: privateKeyToAccount(
          "0x1111111111111111111111111111111111111111111111111111111111111111",
        ).address,
        nonce: NONCE,
        expiresAt: 1779000000000n,
        name: KEY_NAME,
      });
      const sig = await signUniversal(KEY, { primaryType: r.primaryType, message: r.message });
      return {
        path: r.path,
        method: "POST",
        body: r.body,
        signature: sig,
        nonce: NONCE,
        chainId: r.chainId,
        actionType: r.primaryType,
      };
    },
  },
  ...[true, false].map((approve): Case => ({
    name: `ApproveBuilderFeeAction (${approve ? "approve" : "revoke"})`,
    request: async () => {
      const r = approveBuilderFeeRequest({
        user: USER,
        accountID: 20417n,
        builderID: 1645n,
        approve,
        nonce: NONCE,
      });
      const sig = await signUniversal(KEY, { primaryType: r.primaryType, message: r.message });
      return {
        path: r.path,
        method: "POST",
        body: r.body,
        signature: sig,
        nonce: NONCE,
        chainId: r.chainId,
        actionType: r.primaryType,
      };
    },
  })),
  ...(["spot", "perps"] as const).map((engine): Case => ({
    name: `revokeAPIKey (${engine})`,
    request: async () => {
      const r = revokeApiKeyRequest({ engine, accountID: 20417n, name: KEY_NAME, nonce: NONCE });
      return {
        path: r.path,
        method: "DELETE",
        body: r.body,
        signature: await exchangeSig(r.domain, r.payloadHash),
        nonce: NONCE,
        actionType: "revokeAPIKey",
      };
    },
  })),
];

function recordingClient(captures: SodexCallCapture[], status = 200) {
  return new SignedWriteClient({
    config: { restUrl: "https://mainnet-gw.sodex.dev" },
    rateLimit: new MemoryRateLimitStore(),
    egressKey: "test",
    fetch: () =>
      Promise.resolve(
        new Response('{"code":0,"timestamp":1,"data":null}', {
          status,
          headers: { "content-type": "application/json", "set-cookie": "session=abc" },
        }),
      ),
    recorder: {
      record: (c) => {
        captures.push(c);
      },
    },
  });
}

/** Mọi khoá trong một giá trị JSON (đệ quy). */
function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysOf);
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => [k, ...keysOf(v)]);
  }
  return [];
}

describe("SoDEX Debugger redaction", () => {
  it.each(CASES)(
    "stores $name params without the signature or the key name",
    async ({ request }) => {
      const req = await request();
      const captures: SodexCallCapture[] = [];
      await recordingClient(captures).write(req);
      expect(captures).toHaveLength(1);
      const capture = captures[0];
      if (capture === undefined) throw new Error("no capture");

      // Chữ ký không vào hàng đợi.
      const sigHex = req.signature.slice(4).toLowerCase();
      expect(JSON.stringify(capture).toLowerCase()).not.toContain(sigHex);

      const row = toSodexCallRow(capture, "test");
      const stored = JSON.stringify(row);
      expect(stored.toLowerCase()).not.toContain(sigHex);
      expect(stored.toLowerCase()).not.toContain(req.signature.toLowerCase());
      // Tên key chỉ còn 4 ký tự cuối ở header (params của add / revoke key vẫn có tên, đó là dữ liệu đã ký).
      expect(JSON.stringify(row.requestHeaders)).not.toContain(KEY_NAME);
      expect(stored).not.toContain("session=abc");

      const sign = row.requestHeaders.find((h) => h.name === "X-API-Sign");
      expect(sign).toEqual({ name: "X-API-Sign", value: null, redaction: "signature" });
      if (req.apiKeyName !== undefined) {
        expect(row.requestHeaders.find((h) => h.name === "X-API-Key")).toEqual({
          name: "X-API-Key",
          value: "••1117",
          redaction: "masked",
        });
      }
      expect(row.responseHeaders.map((h) => h.name)).not.toContain("set-cookie");

      // Params vẫn được lưu (đúng như đã ký, chỉ định dạng lại).
      expect(row.signed).toBe(true);
      expect(row.actionType).toBe(req.actionType);
      // Tên key / public key ở endpoint api-keys chỉ giữ 4 ký tự cuối (quy tắc 1.9).
      const expected = JSON.parse(req.body) as Record<string, unknown>;
      if (req.path.includes("/api-keys")) {
        for (const k of ["name", "publicKey"]) {
          const v = expected[k];
          if (typeof v === "string") expected[k] = `••${v.slice(-4)}`;
        }
      }
      expect(JSON.parse(row.requestBody ?? "null")).toEqual(expected);

      // Không khoá nào trong body là chữ ký / secret.
      const keys = keysOf(JSON.parse(row.requestBody ?? "null")).map((k) => k.toLowerCase());
      for (const banned of [
        "signature",
        "apisign",
        "privatekey",
        "secret",
        "apisecret",
        "seed",
        "mnemonic",
      ]) {
        expect(keys).not.toContain(banned);
      }
    },
  );

  it("removes signature, private key and secret fields hidden in a body", () => {
    const body = JSON.stringify({
      accountID: 1,
      signature: "0x01" + "ab".repeat(65),
      nested: { privateKey: "0x" + "11".repeat(32), api_secret: "s3cr3t", apiSign: "x" },
      list: [{ seed: "word word" }, { mnemonic: "a b c" }],
      hash: "0x" + "22".repeat(32),
      name: "DeskLabs",
    });
    const out = redactBody(body) ?? "";
    expect(out).not.toContain("ab".repeat(65));
    expect(out).not.toContain("11".repeat(32));
    expect(out).not.toContain("22".repeat(32));
    expect(out).not.toContain("s3cr3t");
    expect(out).not.toContain("word word");
    expect(out).not.toContain("a b c");
    expect(JSON.parse(out)).toMatchObject({
      accountID: 1,
      signature: REDACTED,
      nested: { privateKey: REDACTED, api_secret: REDACTED, apiSign: REDACTED },
      name: "DeskLabs",
    });
  });

  it("drops auth headers and masks the API key name", () => {
    expect(
      redactHeaders({
        Authorization: "Bearer abc",
        Cookie: "a=b",
        "X-API-Key": "DeskLabs",
        "X-API-Nonce": "1",
      }),
    ).toEqual([
      { name: "Authorization", value: null, redaction: "signature" },
      { name: "Cookie", value: null, redaction: "signature" },
      { name: "X-API-Key", value: "••Labs", redaction: "masked" },
      { name: "X-API-Nonce", value: "1", redaction: "none" },
    ]);
  });

  it("keeps non-JSON bodies only when nothing looks like a key", () => {
    expect(redactBody("<html>bad gateway</html>")).toBe("<html>bad gateway</html>");
    expect(redactBody(`oops ${"ab".repeat(32)}`)).toBe(`oops ${REDACTED}`);
  });
});
