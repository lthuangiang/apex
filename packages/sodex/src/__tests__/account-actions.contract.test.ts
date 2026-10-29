import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import {
  addPermissionedApiKeyRequest,
  approveBuilderFeeRequest,
  verifyUniversalSignature,
  wireTypedData,
} from "../actions/account";
import { signUniversal } from "../signing/universal";

// Body so với `json.Marshal` của Go SDK chính thức (sodex-go-sdk-public@548dfd4, DEC-27).
const GO_ADD_KEY_BODY =
  '{"accountID":1645,"name":"DRIFT","type":1,"publicKey":"0x1563915e194D8CfBA1943570603F7606A3115508","expiresAt":1776000000000,"permissions":14}';
// Cùng cấu trúc với json.Marshal của Go SDK; giá trị theo mức hiện tại của DRIFT (10, DEC-46).
const GO_APPROVE_BODY = '{"accountID":1645,"builderID":1645,"maxFeeRate":10}';

const master = privateKeyToAccount(`0x${"11".repeat(32)}`);
const other = privateKeyToAccount(`0x${"33".repeat(32)}`);
const DRIFT_KEY = "0x1563915e194D8CfBA1943570603F7606A3115508";

const addKey = addPermissionedApiKeyRequest({
  user: master.address,
  accountID: 1645n,
  publicKey: DRIFT_KEY,
  nonce: 1776000000001n,
  expiresAt: 1776000000000n,
});
const approve = approveBuilderFeeRequest({
  user: master.address,
  accountID: 1645n,
  builderID: 1645n,
  approve: true,
  nonce: 1776000000002n,
});

describe("account actions (contract)", () => {
  it("serializes the add-key and approve bodies like the Go SDK", () => {
    expect(addKey.body).toBe(GO_ADD_KEY_BODY);
    expect(approve.body).toBe(GO_APPROVE_BODY);
    expect(addKey.path).toBe(`/user/${master.address}/api-keys`);
    expect(approve.path).toBe(`/user/${master.address}/builders`);
  });

  it("always disables cancel, withdraw and transfer, and never sends builder with permissions", () => {
    expect(addKey.message.permissions).toBe(14n);
    expect(addKey.body).not.toContain("builder");
  });

  it("revoke sets maxFeeRate to 0", () => {
    const revoke = approveBuilderFeeRequest({
      user: master.address,
      accountID: 1n,
      builderID: 1645n,
      approve: false,
      nonce: 1n,
    });
    expect(revoke.body).toBe('{"accountID":1,"builderID":1645,"maxFeeRate":0}');
  });

  it("exposes JSON-safe typed data with the universal domain", () => {
    const wire = wireTypedData(addKey);
    expect(wire.domain).toEqual({
      name: "universal",
      version: "1",
      chainId: "286623",
      verifyingContract: "0x0000000000000000000000000000000000000000",
    });
    expect(wire.message).toMatchObject({ chainID: "286623", accountID: "1645", permissions: "14" });
    expect(() => JSON.stringify(wire)).not.toThrow();
  });

  it("accepts the wallet's signature (v = 27/28 or 0/1) and returns the 0x02 header", async () => {
    for (const request of [addKey, approve]) {
      const header = await signUniversal(master, request);
      const raw = `0x${header.slice(4)}` as const;
      const v27: Hex = `0x${raw.slice(2, 130)}${(Number.parseInt(raw.slice(130), 16) + 27).toString(16)}`;
      for (const walletSignature of [raw, v27]) {
        expect(await verifyUniversalSignature(request, walletSignature, master.address)).toBe(
          header,
        );
      }
    }
  });

  it("rejects a signature from another wallet or for another message", async () => {
    const raw = `0x${(await signUniversal(other, approve)).slice(4)}` as const;
    await expect(verifyUniversalSignature(approve, raw, master.address)).rejects.toThrow(
      "does not match",
    );
    const tampered = { ...approve, message: { ...approve.message, maxFeeRate: 2000n } };
    await expect(verifyUniversalSignature(tampered, raw, other.address)).rejects.toThrow(
      "does not match",
    );
  });
});
