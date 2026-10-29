import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import {
  revokeApiKeyRequest,
  verifyRevokeSignature,
  wireRevokeTypedData,
} from "../actions/revoke-key";
import { signExchangeAction } from "../signing/exchange";

// Golden vector từ Go SDK chính thức (sodex-go-sdk-public@548dfd4, SignRevokeAPIKeyRequest), khoá test 0x2222…2222.
const GO = {
  payload: '{"type":"revokeAPIKey","params":{"accountID":1645,"name":"DRIFT"}}',
  payloadHash: "0x39396260be3b87bb36db48029916cb5ab17ea384280211d509ab78325d8f22e6",
  spot: "0x01e542f71cea0d69eb94a1fe11a8db35a25e8868a463a0e1b7cb47d29fc10992c558a141ae8c67083c47133c04788347f71b24e4c7c004fbca270288675edf8ec300",
  perps:
    "0x01df610678a971f43a75465e163f6e9db6ffc3fc93d610f1d2f6a24c46eb1d1c5332493d765fb2c7e6b59d70fc24d781cdf7b4fb103008b1845e4b90941c698e7b01",
};
const master = privateKeyToAccount(`0x${"22".repeat(32)}`);
const nonce = 1760373925001n;

describe("revoke API key (contract)", () => {
  for (const engine of ["spot", "perps"] as const) {
    it(`${engine}: payload, hash and signature match the Go SDK`, async () => {
      const request = revokeApiKeyRequest({ engine, accountID: 1645n, name: "DRIFT", nonce });
      expect(`{"type":"revokeAPIKey","params":${request.body}}`).toBe(GO.payload);
      expect(request.payloadHash).toBe(GO.payloadHash);
      expect(request.path).toBe(`/${engine}/accounts/api-keys`);
      const signature = await signExchangeAction(
        master,
        request.domain,
        request.payloadHash,
        nonce,
      );
      expect(signature).toBe(GO[engine]);

      // Ví trả chữ ký thô (v = 27/28): kiểm tra rồi đổi về header 0x01.
      const raw: Hex = `0x${signature.slice(4, 132)}${(Number.parseInt(signature.slice(132), 16) + 27).toString(16)}`;
      expect(await verifyRevokeSignature(request, raw, master.address)).toBe(GO[engine]);
      expect(wireRevokeTypedData(request).domain.name).toBe(engine === "spot" ? "spot" : "futures");
    });
  }

  it("rejects a signature for the other engine", async () => {
    const spot = revokeApiKeyRequest({ engine: "spot", accountID: 1645n, name: "DRIFT", nonce });
    const perps = revokeApiKeyRequest({ engine: "perps", accountID: 1645n, name: "DRIFT", nonce });
    const raw: Hex = `0x${GO.spot.slice(4)}`;
    await expect(verifyRevokeSignature(spot, raw, master.address)).resolves.toBe(GO.spot);
    await expect(verifyRevokeSignature(perps, raw, master.address)).rejects.toThrow(
      "does not match",
    );
  });
});
