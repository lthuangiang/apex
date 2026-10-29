import { keccak256, stringToBytes, type Hex, type LocalAccount, type TypedDataDomain } from "viem";

import { json, serialize, type JsonValue } from "./canonical-json";
import { SignaturePrefix, SODEX_MAINNET_CHAIN_ID, ZERO_ADDRESS } from "./chain";
import { toSodexSignature } from "./signature";

// Action giao dịch: ký `ExchangeAction{payloadHash, nonce}` trên domain `spot` hoặc `futures`.

export const ExchangeDomain = { spot: "spot", futures: "futures" } as const;
export type ExchangeDomain = (typeof ExchangeDomain)[keyof typeof ExchangeDomain];

export function exchangeDomain(
  name: ExchangeDomain,
  chainId: bigint = SODEX_MAINNET_CHAIN_ID,
): TypedDataDomain {
  return { name, version: "1", chainId, verifyingContract: ZERO_ADDRESS };
}

export const exchangeTypes = {
  ExchangeAction: [
    { name: "payloadHash", type: "bytes32" },
    { name: "nonce", type: "uint64" },
  ],
} as const;

export interface SignedPayload {
  /** Body HTTP: chỉ có `params`, đúng thứ tự field đã hash. */
  body: string;
  payloadHash: Hex;
}

/** `payloadHash = keccak256(JSON gọn của {"type", "params"})`. */
export function buildPayload(type: string, params: JsonValue): SignedPayload {
  const wrapped = serialize(
    json.object([
      ["type", json.string(type)],
      ["params", params],
    ]),
  );
  return { body: serialize(params), payloadHash: keccak256(stringToBytes(wrapped)) };
}

export async function signExchangeAction(
  account: LocalAccount,
  domain: ExchangeDomain,
  payloadHash: Hex,
  nonce: bigint,
  chainId: bigint = SODEX_MAINNET_CHAIN_ID,
): Promise<Hex> {
  const signature = await account.signTypedData({
    domain: exchangeDomain(domain, chainId),
    types: exchangeTypes,
    primaryType: "ExchangeAction",
    message: { payloadHash, nonce },
  });
  return toSodexSignature(signature, SignaturePrefix.exchange);
}
