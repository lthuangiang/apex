import { DRIFT_BUILDER_FEE_RATE } from "@drift/shared";
import { getAddress, isAddressEqual, recoverTypedDataAddress, type Address, type Hex } from "viem";

import { DRIFT_API_KEY_PERMISSIONS } from "../permissions";
import { json, serialize } from "../signing/canonical-json";
import { ApiKeyType, SignaturePrefix, SODEX_MAINNET_CHAIN_ID } from "../signing/chain";
import {
  universalDomain,
  universalTypes,
  type AddPermissionedApiKeyMessage,
  type ApproveBuilderFeeMessage,
} from "../signing/universal";

// Hai action master wallet ký khi kết nối (DEC-25), theo public API "Add API Key" và
// "Approve Builder Fee" (tra ngày 2026-10-27). Body HTTP dùng `type` cho loại key, còn typed data
// dùng `keyType`; nonce trong message phải bằng header `X-API-Nonce`.

/** Tên key DRIFT (docs/SODEX.md mục 5.2). */
export const DRIFT_API_KEY_NAME = "DRIFT";
/** DEC-28: key sống 180 ngày, nhắc trước 14 ngày. */
export const DRIFT_API_KEY_TTL_MS = 180n * 24n * 60n * 60n * 1000n;
export const DRIFT_API_KEY_RENEW_NOTICE_MS = 14 * 24 * 60 * 60 * 1000;

export interface UniversalRequest<
  P extends "UserSignedAddPermissionedAPIKeyAction" | "ApproveBuilderFeeAction",
> {
  primaryType: P;
  message: P extends "ApproveBuilderFeeAction"
    ? ApproveBuilderFeeMessage
    : AddPermissionedApiKeyMessage;
  /** Đường dẫn sau `/api/v1`. */
  path: string;
  body: string;
  nonce: bigint;
  chainId: bigint;
}

export function addPermissionedApiKeyRequest(input: {
  user: Address;
  accountID: bigint;
  publicKey: Address;
  nonce: bigint;
  expiresAt: bigint;
  /** Tên key; mặc định `DRIFT`. Renew dùng `DRIFT-<yyyymmdd>` (DEC-59). SoDEX: `^[0-9a-zA-Z_-]{1,36}$`, khác `default`. */
  name?: string;
}): UniversalRequest<"UserSignedAddPermissionedAPIKeyAction"> {
  const name = input.name ?? DRIFT_API_KEY_NAME;
  if (!/^[0-9a-zA-Z_-]{1,36}$/.test(name) || name === "default") {
    throw new RangeError(`Invalid API key name: ${JSON.stringify(name)}`);
  }
  const message: AddPermissionedApiKeyMessage = {
    chainID: SODEX_MAINNET_CHAIN_ID,
    nonce: input.nonce,
    accountID: input.accountID,
    name,
    keyType: ApiKeyType.evm,
    publicKey: input.publicKey,
    expiresAt: input.expiresAt,
    permissions: DRIFT_API_KEY_PERMISSIONS,
  };
  const body = serialize(
    json.object([
      ["accountID", json.uint(message.accountID)],
      ["name", json.string(message.name)],
      ["type", json.uint(message.keyType)],
      ["publicKey", json.string(message.publicKey)],
      ["expiresAt", json.uint(message.expiresAt)],
      ["permissions", json.uint(message.permissions)],
    ]),
  );
  return {
    primaryType: "UserSignedAddPermissionedAPIKeyAction",
    message,
    path: `/user/${getAddress(input.user)}/api-keys`,
    body,
    nonce: input.nonce,
    chainId: SODEX_MAINNET_CHAIN_ID,
  };
}

/** `maxFeeRate` chỉ là mức của DRIFT (approve, 10 theo DEC-46) hoặc 0 (revoke). */
export function approveBuilderFeeRequest(input: {
  user: Address;
  accountID: bigint;
  builderID: bigint;
  approve: boolean;
  nonce: bigint;
}): UniversalRequest<"ApproveBuilderFeeAction"> {
  const message: ApproveBuilderFeeMessage = {
    chainID: SODEX_MAINNET_CHAIN_ID,
    nonce: input.nonce,
    accountID: input.accountID,
    builderID: input.builderID,
    maxFeeRate: input.approve ? BigInt(DRIFT_BUILDER_FEE_RATE) : 0n,
  };
  const body = serialize(
    json.object([
      ["accountID", json.uint(message.accountID)],
      ["builderID", json.uint(message.builderID)],
      ["maxFeeRate", json.uint(message.maxFeeRate)],
    ]),
  );
  return {
    primaryType: "ApproveBuilderFeeAction",
    message,
    path: `/user/${getAddress(input.user)}/builders`,
    body,
    nonce: input.nonce,
    chainId: SODEX_MAINNET_CHAIN_ID,
  };
}

/** Typed data dạng JSON (uint64 thành chuỗi) để ví ký qua `eth_signTypedData_v4`. */
export function wireTypedData(
  request: UniversalRequest<"UserSignedAddPermissionedAPIKeyAction" | "ApproveBuilderFeeAction">,
) {
  const domain = universalDomain(request.chainId);
  return {
    domain: {
      name: "universal",
      version: "1",
      chainId: request.chainId.toString(),
      verifyingContract: domain.verifyingContract ?? "0x0000000000000000000000000000000000000000",
    },
    types: {
      [request.primaryType]: universalTypes[request.primaryType].map((field) => ({
        name: field.name,
        type: field.type,
      })),
    } as Record<string, { name: string; type: string }[]>,
    primaryType: request.primaryType,
    message: Object.fromEntries(
      Object.entries(request.message).map(([key, value]) => [
        key,
        typeof value === "bigint" ? value.toString() : value,
      ]),
    ) as Record<string, string | number>,
  };
}

/**
 * Chữ ký ví (65 byte, v = 27/28 hoặc 0/1) → `X-API-Sign` (`0x02 || r || s || v∈{0,1}`), sau khi
 * kiểm tra chữ ký đúng là của `expected` cho đúng message này.
 */
export async function verifyUniversalSignature(
  request: UniversalRequest<"UserSignedAddPermissionedAPIKeyAction" | "ApproveBuilderFeeAction">,
  walletSignature: Hex,
  expected: Address,
): Promise<Hex> {
  if (!/^0x[0-9a-fA-F]{130}$/.test(walletSignature)) {
    throw new RangeError("Expected a 65-byte signature");
  }
  const v = Number.parseInt(walletSignature.slice(130), 16);
  const recovery = v >= 27 ? v - 27 : v;
  if (recovery !== 0 && recovery !== 1) throw new RangeError("Invalid recovery id");
  const recovered = await recoverTypedDataAddress({
    domain: universalDomain(request.chainId),
    types: { [request.primaryType]: universalTypes[request.primaryType] },
    primaryType: request.primaryType,
    message: request.message as unknown as Record<string, unknown>,
    signature: walletSignature,
  });
  if (!isAddressEqual(recovered, expected)) {
    throw new RangeError("Signature does not match the wallet address");
  }
  return `0x${SignaturePrefix.universal}${walletSignature.slice(2, 130)}${recovery.toString(16).padStart(2, "0")}`;
}
