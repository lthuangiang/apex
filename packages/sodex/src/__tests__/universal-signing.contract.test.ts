import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import { signUniversal } from "../signing/universal";

// Golden vector chéo SDK, chép từ sodex-python-sdk-public tests/test_api_keys.py
// ("TypeScript SDK golden vector"). Khoá này là khoá test công khai, không phải tài sản thật.
const TEST_MASTER_KEY = "0x0123456789012345678901234567890123456789012345678901234567890123";
const account = privateKeyToAccount(TEST_MASTER_KEY);

const base = {
  accountID: 1010n,
  name: "api-key-01",
  keyType: 1,
  publicKey: "0x3d4595c8742d0a58173a9963c05755b59a8f8256",
  expiresAt: 0n,
  nonce: 1760373925000n,
} as const;

describe("universal signing (contract)", () => {
  it("matches the SoDEX golden vector for AddAPIKey", async () => {
    const signature = await signUniversal(account, { primaryType: "AddAPIKey", message: base });
    expect(signature).toBe(
      "0x027b8db803a8ede1748929c6686fa691a561b3e0f8a338503d8d13ccbff7d745bf51a30ca6f39a4cfd4cc762a1431fe1b5a1a40ba8869808e779ffdc28bcdd0c5201",
    );
  });

  it("matches the SoDEX golden vector for a permissioned API key", async () => {
    const signature = await signUniversal(account, {
      primaryType: "UserSignedAddPermissionedAPIKeyAction",
      message: { ...base, chainID: 286623n, permissions: 3n },
    });
    expect(signature).toBe(
      "0x02ce43d9c70b104dab304eea275f977d3adfac035c6705374db783bdbc84a7f29902b099ba25c508f3da08e0f606efac67a30310c1bf617232d093161a93f2f9a000",
    );
  });

  it("produces 0x02-prefixed 66-byte signatures with v normalized to 0 or 1", async () => {
    const signature = await signUniversal(account, {
      primaryType: "ApproveBuilderFeeAction",
      message: { chainID: 286623n, nonce: 1n, accountID: 1010n, builderID: 7n, maxFeeRate: 50n },
    });
    expect(signature).toMatch(/^0x02[0-9a-f]{128}0[01]$/);
  });
});
