import { isAddressEqual, recoverTypedDataAddress, type Address, type Hex } from "viem";

import { json } from "../signing/canonical-json";
import { SignaturePrefix, SODEX_MAINNET_CHAIN_ID, ZERO_ADDRESS } from "../signing/chain";
import { buildPayload, exchangeDomain, exchangeTypes, ExchangeDomain } from "../signing/exchange";

// Xoá API key (public API "Revoke API Key", tra ngày 2026-10-27): không dùng được chữ ký universal.
// Master wallet ký RIÊNG hai request `revokeAPIKey`, domain `spot` và `futures` (prefix 0x01),
// gửi `DELETE /{spot|perps}/accounts/api-keys` không kèm `X-API-Key`. Hai engine thành công độc lập.

export const RevokeEngine = { spot: "spot", perps: "perps" } as const;
export type RevokeEngine = (typeof RevokeEngine)[keyof typeof RevokeEngine];

export const REVOKE_API_KEY_ACTION = "revokeAPIKey";

export interface RevokeKeyRequest {
  engine: RevokeEngine;
  domain: ExchangeDomain;
  accountID: bigint;
  name: string;
  /** Đường dẫn sau `/api/v1`. */
  path: string;
  body: string;
  payloadHash: Hex;
  nonce: bigint;
  chainId: bigint;
}

export function revokeApiKeyRequest(input: {
  engine: RevokeEngine;
  accountID: bigint;
  name: string;
  nonce: bigint;
}): RevokeKeyRequest {
  const params = json.object([
    ["accountID", json.uint(input.accountID)],
    ["name", json.string(input.name)],
  ]);
  const { body, payloadHash } = buildPayload(REVOKE_API_KEY_ACTION, params);
  return {
    engine: input.engine,
    accountID: input.accountID,
    name: input.name,
    domain: input.engine === RevokeEngine.spot ? ExchangeDomain.spot : ExchangeDomain.futures,
    path: `/${input.engine}/accounts/api-keys`,
    body,
    payloadHash,
    nonce: input.nonce,
    chainId: SODEX_MAINNET_CHAIN_ID,
  };
}

/** Typed data `ExchangeAction{payloadHash, nonce}` dạng JSON để ví ký. */
export function wireRevokeTypedData(request: RevokeKeyRequest) {
  return {
    domain: {
      name: request.domain,
      version: "1",
      chainId: request.chainId.toString(),
      verifyingContract: ZERO_ADDRESS,
    },
    types: {
      ExchangeAction: exchangeTypes.ExchangeAction.map((f) => ({ name: f.name, type: f.type })),
    } as Record<string, { name: string; type: string }[]>,
    primaryType: "ExchangeAction",
    message: { payloadHash: request.payloadHash, nonce: request.nonce.toString() } as Record<
      string,
      string | number
    >,
  };
}

/** Chữ ký ví (65 byte) → `X-API-Sign` (`0x01 || r || s || v∈{0,1}`), sau khi kiểm tra đúng ví. */
export async function verifyRevokeSignature(
  request: RevokeKeyRequest,
  walletSignature: Hex,
  expected: Address,
): Promise<Hex> {
  if (!/^0x[0-9a-fA-F]{130}$/.test(walletSignature))
    throw new RangeError("Expected a 65-byte signature");
  const v = Number.parseInt(walletSignature.slice(130), 16);
  const recovery = v >= 27 ? v - 27 : v;
  if (recovery !== 0 && recovery !== 1) throw new RangeError("Invalid recovery id");
  const recovered = await recoverTypedDataAddress({
    domain: exchangeDomain(request.domain, request.chainId),
    types: exchangeTypes,
    primaryType: "ExchangeAction",
    message: { payloadHash: request.payloadHash, nonce: request.nonce },
    signature: walletSignature,
  });
  if (!isAddressEqual(recovered, expected))
    throw new RangeError("Signature does not match the wallet address");
  return `0x${SignaturePrefix.exchange}${walletSignature.slice(2, 130)}${recovery.toString(16).padStart(2, "0")}`;
}
