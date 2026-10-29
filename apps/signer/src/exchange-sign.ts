// Signer không phụ thuộc @drift/sodex để giữ bề mặt nhỏ; định nghĩa EIP-712 khớp packages/sodex
// (contract test ở đó đã đối chiếu Go SDK, DEC-27). Test riêng ở signer đối chiếu cùng vector.
import type { Hex, LocalAccount } from "viem";

const ZERO = "0x0000000000000000000000000000000000000000";
export const SODEX_MAINNET_CHAIN_ID = 286623n;

export async function signExchangeAction(
  account: LocalAccount,
  domain: "spot" | "futures",
  payloadHash: Hex,
  nonce: bigint,
): Promise<Hex> {
  const signature = await account.signTypedData({
    domain: {
      name: domain,
      version: "1",
      chainId: SODEX_MAINNET_CHAIN_ID,
      verifyingContract: ZERO,
    },
    types: {
      ExchangeAction: [
        { name: "payloadHash", type: "bytes32" },
        { name: "nonce", type: "uint64" },
      ],
    },
    primaryType: "ExchangeAction",
    message: { payloadHash, nonce },
  });
  const v = Number.parseInt(signature.slice(130), 16);
  const recovery = v >= 27 ? v - 27 : v;
  return `0x01${signature.slice(2, 130)}${recovery.toString(16).padStart(2, "0")}`;
}
