import type { ActionKind } from "./actions";

// Trạng thái popup Claim / Open / Merge của tab (#551). Một store chung cho thẻ Overview và trang /rewards: đóng popup
// không huỷ job, job vẫn được theo dõi và hiện lại ở dòng job / dải "xong". Chỉ giữ trong bộ nhớ của tab; sau reload,
// job đang chạy được khôi phục từ `jobs?active=true` (không lưu gì thêm).

export interface Pick {
  kind: ActionKind;
  /** Số box (claim: số muốn claim; open / merge: số token). */
  count: number;
  level: string | null;
  /** Token gửi đi, tăng dần (open / merge). */
  tokenIds: number[];
  /** Backpack lúc bắt đầu (claim: "Backpack {before} → {after}"). */
  before: number | null;
}

export type Flow =
  | ({ step: "confirm" } & Pick)
  /** Chưa kết nối ví: chọn ví rồi ký tiếp. */
  | ({ step: "picker" } & Pick)
  | ({ step: "wallet" } & Pick)
  | ({ step: "sending" } & Pick)
  /** POST không rõ kết quả: đang đọc `jobs?active=true`. */
  | ({ step: "checking" } & Pick)
  /** Đối soát không tìm thấy job: không gửi lại, chỉ đóng. */
  | ({ step: "unsure" } & Pick)
  | ({ step: "job"; jobId: number; note: "recovered" | "already" | null } & Pick)
  | ({
      step: "error";
      reason: "rejected" | "failed" | "expired" | "busy" | "wallet";
      said: string | null;
      /** Ví đang kết nối khi sai ví. */
      connected?: string;
    } & Pick);

export interface ActionState {
  open: boolean;
  flow: Flow | null;
  /** Job vừa xong khi popup đang đóng: dải "5 boxes opened · See results". */
  done: { jobId: number; pick: Pick } | null;
}

let state: ActionState = { open: false, flow: null, done: null };
/** Tăng mỗi lần bắt đầu / huỷ: kết quả của luồng cũ (ví ký muộn…) bị bỏ, không gửi. */
let token = 0;
const listeners = new Set<() => void>();

export function getActionState(): ActionState {
  return state;
}

export function subscribeActions(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function setActionState(next: Partial<ActionState>): void {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

export function actionToken(): number {
  return token;
}

export function newActionToken(): number {
  token += 1;
  return token;
}

/** Chỉ cho test. */
export function resetActions(): void {
  token += 1;
  state = { open: false, flow: null, done: null };
  for (const l of listeners) l();
}
