import {
  LOTTERY_REQUEST_FIELDS,
  lotteryJobRefSchema,
  lotteryJobsSchema,
  type LotteryBox,
  type LotteryJob,
  type LotterySignParams,
} from "@drift/shared";
import type { Hex, TypedData as ViemTypedData, TypedDataDefinition } from "viem";

import { RewardsError } from "./client";
import { mintedMs } from "./format";
import type { RewardsSession } from "./queries";

// Logic Claim / Open / Merge của Blind Boxes (#551, DEC-397), thuần, không React. Trạng thái của job chỉ lấy từ
// `lottery/job/{id}` và `jobs?active=true` (quy tắc 6). POST không rõ kết quả (timeout, lỗi mạng, HTTP lạ) không bao giờ
// gửi lại: đọc `jobs?active=true` để tìm job (quy tắc 7). Không có giao dịch on-chain: open / merge là chữ ký EIP-712.

export type ActionKind = "claim" | "open" | "merge";

/** `kind` của job phía SoDEX theo thao tác. */
export const SODEX_KIND: Record<ActionKind, string> = {
  claim: "treasure",
  open: "open",
  merge: "merge",
};

export function actionOfJob(job: Pick<LotteryJob, "kind">): ActionKind {
  const k = job.kind.toLowerCase();
  if (k.includes("merge")) return "merge";
  if (k.includes("treasure") || k.includes("claim")) return "claim";
  return "open";
}

/** POST không đợi quá ngần này; quá thì coi là không rõ kết quả và đi đối soát. */
export const ACTION_POST_TIMEOUT_MS = 20_000;

/** Box nằm trong job chưa xong (open: `boxes[]`, merge: `result.consumedTokenIds`). */
export function busyTokenIds(jobs: readonly LotteryJob[]): Set<number> {
  const busy = new Set<number>();
  for (const j of jobs) {
    if (j.status !== "submitting" && j.status !== "pending") continue;
    for (const b of j.boxes ?? []) busy.add(b.tokenId);
    for (const id of j.result?.consumedTokenIds ?? []) busy.add(id);
  }
  return busy;
}

/**
 * Box cũ nhất trước (DEC-397 (4)): cùng `level`, bỏ box đang trong job; xếp `mintedAt` tăng dần, bằng nhau theo `tokenId`;
 * box thiếu `mintedAt` xếp sau box có, theo `tokenId`. Lấy `n` box rồi trả `tokenId` tăng dần nghiêm ngặt (yêu cầu của
 * `box/open` / `box/merge`).
 */
export function pickOldest(
  boxes: readonly LotteryBox[],
  level: string,
  n: number,
  busy: ReadonlySet<number> = new Set(),
): number[] {
  const picked = boxes
    .filter((b) => b.level === level && !busy.has(b.tokenId))
    .map((b) => ({ id: b.tokenId, ms: mintedMs(b.mintedAt) }))
    .sort((a, b) => {
      if (a.ms !== b.ms) return a.ms === null ? 1 : b.ms === null ? -1 : a.ms - b.ms;
      return a.id - b.id;
    })
    .slice(0, Math.max(0, n))
    .map((x) => x.id);
  return [...new Set(picked)].sort((a, b) => a - b);
}

/** Typed data `RequestOpen` / `RequestMerge` từ sign-params (domain, nonce, deadline) + ví + token ID. */
export function boxTypedData(
  params: LotterySignParams,
  owner: string,
  tokenIds: readonly number[],
): TypedDataDefinition {
  return {
    domain: {
      name: params.domainName,
      version: params.domainVersion,
      chainId: BigInt(params.chainId),
      verifyingContract: params.verifyingContract as Hex,
    },
    // Đã parse bằng zod; viem chỉ cần đúng hình dạng `{ name, type }[]` (như toSignable của use-sodex-signature).
    types: { [params.primaryType]: [...LOTTERY_REQUEST_FIELDS] } as unknown as ViemTypedData,
    primaryType: params.primaryType,
    message: {
      owner: owner,
      tokenIds: tokenIds.map((id) => BigInt(id)),
      nonce: BigInt(String(params.nonce)),
      deadline: BigInt(params.deadline),
    },
  };
}

/** "previous … still in progress (job N)" của SoDEX → N. */
export function inProgressJobId(message: string | null): number | null {
  if (message === null) return null;
  const m = /still in progress[^0-9]*\(?\s*job\s*#?\s*(\d+)/i.exec(message);
  return m === null ? null : Number(m[1]);
}

export type PostOutcome =
  /** SoDEX nhận, có job. */
  | { kind: "job"; jobId: number }
  /** Job trước còn chạy: theo job đó, không gửi mới. */
  | { kind: "already"; jobId: number }
  /** Không rõ đã gửi được chưa: phải đối soát, không gửi lại. */
  | { kind: "unknown" }
  /** SoDEX từ chối rõ ràng (code ≠ 0). */
  | { kind: "rejected"; said: string | null }
  | { kind: "expired" }
  | { kind: "busy" };

export type Authed = RewardsSession["authed"];

/** Gửi một POST thao tác một lần duy nhất và phân loại kết quả. */
export async function postAction(
  authed: Authed,
  path: "lottery/treasure/open" | "lottery/box/open" | "lottery/box/merge",
  body: unknown,
  timeoutMs = ACTION_POST_TIMEOUT_MS,
): Promise<PostOutcome> {
  try {
    const ref = await authed({
      method: "POST",
      path,
      body,
      schema: lotteryJobRefSchema,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { kind: "job", jobId: ref.jobId };
  } catch (e) {
    if (!(e instanceof RewardsError)) return { kind: "unknown" };
    if (e.kind === "expired") return { kind: "expired" };
    if (e.kind === "rate_limited") return { kind: "busy" };
    if (e.kind === "business") {
      const n = inProgressJobId(e.sodexMessage);
      return n === null
        ? { kind: "rejected", said: e.sodexMessage }
        : { kind: "already", jobId: n };
    }
    // network (gồm timeout), http (5xx…), schema: không biết SoDEX đã nhận chưa.
    return { kind: "unknown" };
  }
}

/** Đối soát sau POST không rõ: job chưa xong mới nhất cùng loại trong `jobs?active=true`; không có hoặc lỗi → null. */
export async function findActiveJob(authed: Authed, action: ActionKind): Promise<number | null> {
  try {
    const { jobs } = await authed({
      path: "lottery/jobs",
      query: { active: true },
      schema: lotteryJobsSchema,
    });
    const same = jobs.filter((j) => actionOfJob(j) === action);
    return same.reduce<number | null>(
      (max, j) => (max === null || j.jobId > max ? j.jobId : max),
      null,
    );
  } catch {
    return null;
  }
}
