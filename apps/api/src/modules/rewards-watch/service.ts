import { rewardsWatch, sodexAccounts, type Db } from "@drift/db";
import {
  AppError,
  ErrorCode,
  type RewardsWatchEnableBody,
  type RewardsWatchPauseReason,
  type RewardsWatchState,
} from "@drift/shared";
import type { RewardsReadClient } from "@drift/sodex";
import { and, desc, eq } from "drizzle-orm";

import { audit, AuditAction } from "../../lib/audit";
import { markSideEffect } from "../../lib/idempotency";

import { checkRewardsAud, readRewardsJwtClaims } from "./claims";

// Báo box mới SoDEX rewards (#558, DEC-398): nhận phiên rewards (JWT) một lần khi người dùng bật, kiểm ví và phạm vi
// token, nhờ signer mã hoá (Vault transit `drift-rewards`), lưu ciphertext + hạn vào `rewards_watch`. Không bao giờ log,
// trả lại hay audit token. Server chỉ đọc gateway qua client chỉ đọc (`@drift/sodex` `RewardsReadClient`).

/**
 * Vì sao signer không mã hoá được (#582): `http_<status>` khi signer trả khác 200 (503 = Vault lỗi / khoá rewards chưa
 * cấu hình, 403 = CN không được phép), `timeout` / `network` (gồm mTLS), `bad_response` khi body lạ. Không chứa token.
 */
export type RewardsSignerFailure = `http_${string}` | "timeout" | "network" | "bad_response";

/** Mã hoá JWT ở signer (CN `api`). `failure` = signer / Vault không làm được (chưa lưu gì). */
export interface RewardsTokenSigner {
  encrypt(
    token: string,
  ): Promise<{ ciphertext: string; keyRef: string } | { failure: RewardsSignerFailure }>;
}

export interface RewardsWatchDeps {
  db: Db;
  now: () => Date;
  /**
   * `REWARDS_JWT_AUD_ALLOW`; trống = từ chối mọi token. Hàm (như `enabled`) để đọc giá trị hiện tại mỗi request, không
   * chụp một lần lúc dựng app.
   */
  audAllow: () => readonly string[];
  reader: Pick<RewardsReadClient, "getSopointsSummary">;
  signer: RewardsTokenSigner;
}

/** Lỗi đọc gateway liên tiếp từ mức này thì trạng thái báo "delayed". */
export const REWARDS_WATCH_DELAYED_AFTER = 3;

async function connectedAccount(db: Db, userId: string) {
  const [account] = await db
    .select({ id: sodexAccounts.id, address: sodexAccounts.address })
    .from(sodexAccounts)
    .where(and(eq(sodexAccounts.userId, userId), eq(sodexAccounts.status, "connected")))
    .orderBy(desc(sodexAccounts.createdAt))
    .limit(1);
  return account ?? null;
}

const OFF: RewardsWatchState = {
  status: "off",
  reason: null,
  expiresAt: null,
  lastCheckedAt: null,
  delayed: false,
};

/** `GET /api/v1/rewards/watch`: trạng thái công tắc lấy từ backend (quy tắc 6). Không trả token. */
export async function getRewardsWatchState(
  deps: Pick<RewardsWatchDeps, "db" | "now">,
  userId: string,
): Promise<RewardsWatchState> {
  const [row] = await deps.db
    .select()
    .from(rewardsWatch)
    .where(eq(rewardsWatch.userId, userId))
    .limit(1);
  if (row === undefined) return OFF;
  const account = await connectedAccount(deps.db, userId);
  let reason: RewardsWatchPauseReason | null = null;
  if (account?.id !== row.sodexAccountId) reason = "wallet_changed";
  else if (row.status === "paused") reason = row.pauseReason ?? "unauthorized";
  else if (row.tokenExp.getTime() <= deps.now().getTime()) reason = "expired";
  return {
    status: reason === null ? "active" : "paused",
    reason,
    expiresAt: row.tokenExp.toISOString(),
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    delayed: reason === null && row.consecutiveErrors >= REWARDS_WATCH_DELAYED_AFTER,
  };
}

/** `POST /api/v1/rewards/watch`: bật báo box mới bằng JWT vừa ký trên trình duyệt. */
export async function enableRewardsWatch(
  deps: RewardsWatchDeps,
  userId: string,
  body: RewardsWatchEnableBody,
  ip: string | null,
): Promise<RewardsWatchState> {
  const account = await connectedAccount(deps.db, userId);
  if (account === null)
    throw new AppError(ErrorCode.sodexAccountNotFound, "Connect your SoDEX account first.");
  if (account.address.toLowerCase() !== body.address.toLowerCase())
    throw new AppError(ErrorCode.rewardsWalletMismatch, "This sign-in is for another wallet.", {
      reason: "address",
    });

  const claims = readRewardsJwtClaims(body.token, deps.now().getTime());
  if ("problem" in claims)
    throw new AppError(ErrorCode.rewardsTokenInvalid, "This rewards sign-in can't be used.", {
      reason: claims.problem,
    });
  const audProblem = checkRewardsAud(claims.aud, deps.audAllow());
  if (audProblem !== null)
    throw new AppError(ErrorCode.rewardsTokenInvalid, "This rewards sign-in can't be used.", {
      reason: audProblem,
    });

  // JWT không có claim ví: hỏi SoDEX ví của token (chỉ đọc) và so với master wallet của tài khoản.
  const summary = await deps.reader.getSopointsSummary(body.token);
  switch (summary.kind) {
    case "ok": {
      const wallet = summary.data.walletAddress;
      if (wallet == null || wallet === "")
        throw new AppError(ErrorCode.rewardsWatchUnavailable, "Couldn't turn on alerts.", {
          reason: "wallet_unverified",
        });
      if (wallet.toLowerCase() !== account.address.toLowerCase())
        throw new AppError(ErrorCode.rewardsWalletMismatch, "This sign-in is for another wallet.", {
          reason: "token_wallet",
        });
      break;
    }
    case "unauthorized":
      throw new AppError(ErrorCode.rewardsTokenInvalid, "This rewards sign-in can't be used.", {
        reason: "unauthorized",
      });
    case "invalid_token":
      throw new AppError(ErrorCode.rewardsTokenInvalid, "This rewards sign-in can't be used.", {
        reason: "malformed",
      });
    case "rate_limited":
    case "budget":
      throw new AppError(ErrorCode.rateLimited, "SoDEX rewards is busy. Try again later.", {
        ...(summary.retryAfterMs === null ? {} : { retryAfterMs: summary.retryAfterMs }),
      });
    case "error":
      // #582: giữ mã con (network / timeout / http_status / schema / business…) để đọc log là biết nhánh.
      throw new AppError(ErrorCode.rewardsWatchUnavailable, "Couldn't turn on alerts.", {
        reason: "gateway",
        cause: summary.code,
        ...(summary.status === undefined ? {} : { status: summary.status }),
        ...(summary.businessCode === undefined ? {} : { businessCode: summary.businessCode }),
      });
  }

  const encrypted = await deps.signer.encrypt(body.token);
  if ("failure" in encrypted)
    throw new AppError(ErrorCode.rewardsWatchUnavailable, "Couldn't turn on alerts.", {
      reason: "signer",
      cause: encrypted.failure,
    });

  markSideEffect();
  const now = deps.now();
  const values = {
    sodexAccountId: account.id,
    status: "active" as const,
    pauseReason: null,
    tokenCiphertext: encrypted.ciphertext,
    kmsKeyRef: encrypted.keyRef,
    tokenExp: new Date(claims.exp * 1000),
    tokenIat: claims.iat === null ? null : new Date(claims.iat * 1000),
    tokenAud: claims.aud,
    tokenIss: claims.iss,
    jti8: claims.jti8,
    // Lượt đầu của scheduler đặt mốc = hiện tại, không báo lịch sử cũ.
    ledgerMarkTsMs: null,
    ledgerMarkIds: [],
    grantedMark: null,
    drawRoundsSeen: [],
    baselinePending: true,
    nextCheckAt: now,
    lastCheckedAt: null,
    consecutiveErrors: 0,
    lastErrorCode: null,
  };
  await deps.db
    .insert(rewardsWatch)
    .values({ userId, ...values })
    .onConflictDoUpdate({ target: rewardsWatch.userId, set: values });
  await audit(deps.db, {
    userId,
    action: AuditAction.rewardsWatchEnabled,
    target: account.id,
    metadata: { jti8: claims.jti8, exp: claims.exp },
    ip,
  });
  return getRewardsWatchState(deps, userId);
}

export type RewardsWatchRemoveReason = "user" | "sign_out" | "sodex_disconnect" | "account_deleted";

/**
 * Xoá dòng `rewards_watch` (gồm ciphertext) của user: tắt công tắc, "Sign out of rewards", đăng xuất DeskLabs chủ động,
 * ngắt SoDEX, xoá tài khoản (DEC-398). Idempotent. Ghi audit khi có dòng bị xoá.
 */
export async function removeRewardsWatch(
  db: Pick<Db, "delete" | "insert">,
  userId: string,
  reason: RewardsWatchRemoveReason,
  ip: string | null,
): Promise<boolean> {
  const deleted = await db
    .delete(rewardsWatch)
    .where(eq(rewardsWatch.userId, userId))
    .returning({ userId: rewardsWatch.userId });
  if (deleted.length === 0) return false;
  await audit(db, {
    userId,
    action: AuditAction.rewardsWatchDisabled,
    metadata: { reason },
    ip,
  });
  return true;
}
