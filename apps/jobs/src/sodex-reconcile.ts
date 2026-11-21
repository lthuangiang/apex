import { AppError, ErrorCode } from "@drift/shared";
import { newTraceId, withSodexCallContext } from "@drift/sodex";
import {
  listUnknownSignatureRequests,
  reconcileSignatureRequest,
  type SignatureReconcileDeps,
} from "@drift/sodex-reconcile";

// Vòng đối soát nền cho request ký SoDEX `unknown` (#327, quy tắc 1.7): người dùng đóng tab khi đang chờ thì không còn
// web nào gọi `/reconciliation`; request `unknown` sẽ chặn ý định builder fee ngược chiều (`builder_fee_in_flight`).
// Mỗi ~90 giây đọc lại trạng thái thật trên SoDEX (chỉ đọc, client có rate limit, ưu tiên background) cho một lô nhỏ,
// bằng CÙNG hàm với endpoint của api. Request quá cửa sổ nonce 2 ngày không còn được lấy (trần cuối cùng).

export const SIGNATURE_RECONCILE_INTERVAL_MS = 90_000;
export const SIGNATURE_RECONCILE_BATCH = 20;

export interface SignatureReconcileLog {
  info(data: Record<string, unknown>, msg: string): void;
  warn(data: Record<string, unknown>, msg: string): void;
}

/** Một lượt: trả số request đã kết luận (rời `unknown`). Hết hạn mức SoDEX thì dừng lượt này, lượt sau đọc tiếp. */
export async function reconcileUnknownSignaturesOnce(
  deps: SignatureReconcileDeps,
  log: SignatureReconcileLog,
  batch: number = SIGNATURE_RECONCILE_BATCH,
): Promise<number> {
  const rows = await listUnknownSignatureRequests(deps.db, deps.now(), batch);
  let resolved = 0;
  for (const row of rows) {
    const traceId = newTraceId();
    try {
      const after = await withSodexCallContext({ accountId: row.sodexAccountId, traceId }, () =>
        reconcileSignatureRequest(deps, row.id),
      );
      if (after.status !== "unknown") {
        resolved += 1;
        log.info(
          { traceId, requestId: row.id, action: after.action, status: after.status },
          "signature request reconciled",
        );
      }
    } catch (error) {
      const code = error instanceof AppError ? error.code : undefined;
      log.warn(
        { traceId, requestId: row.id, code, err: error instanceof Error ? error.message : error },
        "signature request reconcile failed",
      );
      if (code === ErrorCode.rateLimited) break;
    }
  }
  return resolved;
}
