import type { createDb } from "@drift/db";

type Pool = ReturnType<typeof createDb>["pool"];

// Khi Postgres cắt phiên vì `idle_in_transaction_session_timeout` (FATAL 25P03), node-pg phát `error` trên client đang giữ
// transaction. Không ai nghe thì process sập với một stack khó hiểu. CLI replay gắn handler này để in "Aborted: …" và
// thoát mã 2. Không đụng `createDb` (pool của server giữ nguyên hành vi).

export const IDLE_KILL_CODE = "25P03";
export const IDLE_KILL_MESSAGE = "Aborted: idle-in-transaction timeout";

const codeOf = (e: unknown): unknown =>
  typeof e === "object" && e !== null && "code" in e ? e.code : undefined;

/** Thời gian chờ 25P03 đi kèm sau một lỗi "Connection terminated" trên cùng client. */
const TERMINATED_GRACE_MS = 250;

const isConnectionTerminated = (e: unknown): boolean =>
  e instanceof Error && codeOf(e) === undefined && /Connection terminated/i.test(e.message);

/** Lỗi là phiên bị cắt vì ngồi im trong transaction. */
export function isIdleKill(e: unknown): boolean {
  return codeOf(e) === IDLE_KILL_CODE;
}

/**
 * Gắn handler `error` cho mọi client mới của `pool` (và cho lỗi chưa ai bắt trong process): phiên bị cắt vì idle thì gọi
 * `onKill`; lỗi client khác chuyển cho `onOther`. Trả về hàm gỡ handler.
 */
export function guardIdleKill(
  pool: Pool,
  onKill: () => void,
  onOther: (e: unknown) => void = () => undefined,
): () => void {
  const onConnect = (client: { on: (event: "error", f: (e: Error) => void) => unknown }) => {
    // Sau FATAL 25P03, node-pg còn phát thêm "Connection terminated unexpectedly" (không có code) trên cùng client,
    // trước hoặc sau lỗi 25P03 tuỳ thời điểm socket đóng. Lỗi đó là một phần của lần cắt, không phải lỗi khác: chờ
    // một nhịp ngắn để xem 25P03 có tới không rồi mới chuyển cho `onOther`.
    let killed = false;
    let pending: { e: unknown; timer: ReturnType<typeof setTimeout> } | undefined;
    client.on("error", (e: unknown) => {
      if (isIdleKill(e)) {
        killed = true;
        if (pending !== undefined) clearTimeout(pending.timer);
        pending = undefined;
        onKill();
        return;
      }
      if (isConnectionTerminated(e)) {
        if (killed || pending !== undefined) return;
        pending = {
          e,
          timer: setTimeout(() => {
            pending = undefined;
            if (!killed) onOther(e);
          }, TERMINATED_GRACE_MS),
        };
        return;
      }
      onOther(e);
    });
  };
  // Có listener thì Node không tự in lỗi và thoát nữa: lỗi khác in stack ra stderr rồi thoát mã 1 như mặc định.
  const onUncaught = (e: unknown) => {
    if (isIdleKill(e)) {
      onKill();
      return;
    }
    process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    process.exit(1);
  };
  pool.on("connect", onConnect);
  process.on("uncaughtException", onUncaught);
  return () => {
    pool.off("connect", onConnect);
    process.off("uncaughtException", onUncaught);
  };
}
