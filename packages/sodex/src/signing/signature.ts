import { hexToBytes, type Hex } from "viem";

import type { SignaturePrefix } from "./chain";

/**
 * Đổi chữ ký 65 byte `r || s || v` thành định dạng SoDEX `prefix || r || s || v`,
 * với `v` chuẩn hoá về 0/1 (docs/SODEX.md mục 5.1).
 */
export function toSodexSignature(signature: Hex, prefix: SignaturePrefix): Hex {
  const bytes = hexToBytes(signature);
  if (bytes.length !== 65) {
    throw new RangeError("Expected a 65-byte signature");
  }
  const v = bytes[64] ?? 0;
  const normalized = v >= 27 ? v - 27 : v;
  if (normalized !== 0 && normalized !== 1) {
    throw new RangeError("Invalid recovery id");
  }
  const rs = signature.slice(2, 130);
  return `0x${prefix}${rs}${normalized.toString(16).padStart(2, "0")}`;
}
