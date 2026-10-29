// Mặt nạ `permissions` của SoDEX: bit được đặt nghĩa là quyền đó bị TẮT (docs/SODEX.md mục 5.2).

export const ApiKeyPermissionBit = {
  trade: 1n,
  cancel: 2n,
  withdraw: 4n,
  transfer: 8n,
} as const;

/**
 * Key của DRIFT (DEC-25): tắt CANCEL, WITHDRAW, TRANSFER; giữ TRADE (theo SDK, TRADE gồm cả
 * huỷ lệnh). [confirm] Phải kiểm chứng trên mainnet trước khi bật luồng kết nối.
 */
export const DRIFT_API_KEY_PERMISSIONS =
  ApiKeyPermissionBit.cancel | ApiKeyPermissionBit.withdraw | ApiKeyPermissionBit.transfer;

/** Key không có quyền rút và chuyển tiền (quy tắc 1.1). Dùng khi đọc lại key từ SoDEX. */
export function blocksWithdrawAndTransfer(permissions: bigint | undefined): boolean {
  if (permissions === undefined) return false;
  const blocked = ApiKeyPermissionBit.withdraw | ApiKeyPermissionBit.transfer;
  return (permissions & blocked) === blocked;
}
