import type { Db, DbTx } from "@drift/db";
import {
  apiKeys,
  bots,
  builderApprovals,
  sodexAccounts,
  sodexSignatureRequests,
  users,
} from "@drift/db";
import {
  AppError,
  isBuilderAccount,
  isBuilderFeeApproved,
  ReasonCode,
  ErrorCode,
  SignatureAction,
  SignatureRequestStatus,
  type SignatureRequest,
  type SodexConnection,
} from "@drift/shared";
import {
  addPermissionedApiKeyRequest,
  approveBuilderFeeRequest,
  DRIFT_API_KEY_NAME,
  DRIFT_API_KEY_TTL_MS,
  newTraceId,
  REVOKE_API_KEY_ACTION,
  revokeApiKeyRequest,
  RevokeEngine,
  verifyRevokeSignature,
  verifyUniversalSignature,
  wireRevokeTypedData,
  wireTypedData,
  withSodexCallContext,
  type SignedWriteClient,
  type SodexRestClient,
  type RevokeKeyRequest,
  type UniversalRequest,
} from "@drift/sodex";
import {
  addKeyMessageSchema,
  approveMessageSchema,
  reconcileSignatureRequest,
  SODEX_NONCE_WINDOW_MS,
} from "@drift/sodex-reconcile";
import { and, desc, eq, gte, inArray, ne, sql } from "drizzle-orm";
import { getAddress, type Address, type Hex } from "viem";
import { z } from "zod";

import { AuditAction, audit } from "../../lib/audit";
import { markSideEffect } from "../../lib/idempotency";
import { removeRewardsWatch } from "../rewards-watch/service";
import { removeWealthWatch } from "../wealth-watch/service";
import { iso } from "../security/service";
import { verifyTwoFactor, type TwoFactorDeps } from "../security/two-factor";

// Kết nối SoDEX bằng hai chữ ký master wallet (DEC-25, SODEX.md mục 5.2):
//   1. UserSignedAddPermissionedAPIKeyAction: key DRIFT do signer sinh, mặt nạ 14.
//   2. ApproveBuilderFeeAction: 50 (hoặc 0 khi revoke).
// Server dựng message, ví ký, server kiểm tra chữ ký, gửi SoDEX, rồi ĐỌC LẠI trước khi báo thành công.
// Không retry ghi (quy tắc 1.7): kết quả không rõ → `unknown`, chỉ đọc lại để đối soát.

/** Thời gian ví được phép ký một request; nonce phải còn trong cửa sổ của SoDEX. */
export const SIGNATURE_REQUEST_TTL_MS = 10 * 60 * 1000;

/**
 * Request `pending` còn ít nhất chừng này để ký thì được dùng lại thay vì tạo request mới (#318): hai lần bấm, hai tab
 * hay bấm lại sau timeout với Idempotency-Key khác vẫn chỉ có một key ở signer và một request ký được.
 */
export const SIGNATURE_REQUEST_REUSE_MIN_MS = 2 * 60 * 1000;

/**
 * `sodex_error` của request `pending` bị thay bằng request mới: cùng loại mà sắp hết hạn (#318), hoặc ý định
 * builder-fee ngược chiều (#327).
 */
export const SIGNATURE_REQUEST_SUPERSEDED = "superseded";

/** `details.reason` khi approve / revoke builder fee ngược chiều còn đang chờ SoDEX xác nhận (#327). */
export const BUILDER_FEE_IN_FLIGHT = "builder_fee_in_flight";

export interface SignerClient {
  createApiKey(input: { sodexAccountId: string; name: string; expiresAt: string }): Promise<{
    id: string;
    publicKey: string;
  }>;
  /**
   * Signer giải mã thử key rồi bỏ (`POST /v1/keys/:id/verify`), không ký. `unusable` = cần người dùng ký lại;
   * `unavailable` = không hỏi được signer lúc này.
   */
  verifyApiKey(id: string): Promise<"ok" | "unusable" | "unavailable">;
}

export interface SodexDeps extends TwoFactorDeps {
  rest: SodexRestClient;
  writer: SignedWriteClient;
  signer: SignerClient;
  builderId: bigint;
  /** Account builder được miễn builder fee (DEC-47); false = thu như mọi account (DEC-124). Thiếu = true. */
  builderExempt?: boolean | undefined;
  /** Chỉ bật sau khi đã kiểm chứng mặt nạ 14 trên mainnet (SODEX.md mục 5.2). */
  connectEnabled: boolean;
}

const uint = z.string().regex(/^\d+$/).transform(BigInt);
const revokeMessageSchema = z.object({ accountID: uint, name: z.string(), nonce: uint });

const REVOKE_ACTIONS: ReadonlySet<string> = new Set([
  SignatureAction.revokeApiKeySpot,
  SignatureAction.revokeApiKeyPerps,
]);

type Row = typeof sodexSignatureRequests.$inferSelect;
type AnyRequest = UniversalRequest<
  "UserSignedAddPermissionedAPIKeyAction" | "ApproveBuilderFeeAction"
>;

export async function getConnection(deps: SodexDeps, userId: string): Promise<SodexConnection> {
  const account = await currentAccount(deps.db, userId);
  if (account === undefined) return { connection: null };
  const [key] = await deps.db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.sodexAccountId, account.id), ne(apiKeys.status, "pending")))
    .orderBy(desc(apiKeys.createdAt))
    .limit(1);
  const [fee] = await deps.db
    .select()
    .from(builderApprovals)
    .where(
      and(
        eq(builderApprovals.sodexAccountId, account.id),
        eq(builderApprovals.builderId, deps.builderId),
      ),
    )
    .limit(1);
  const now = deps.now();
  // Bot bị pause `API_KEY_UNUSABLE` sau khi key này được tạo: engine đã không ký được bằng key này dù lần
  // verify vừa rồi có thể qua (UI_REVIEW J2). Key mới (renew) thì tín hiệu cũ không còn tính.
  const pausedForKey =
    key === undefined
      ? []
      : await deps.db
          .select({ id: bots.id })
          .from(bots)
          .where(
            and(
              eq(bots.sodexAccountId, account.id),
              eq(bots.state, "paused"),
              eq(bots.reasonCode, ReasonCode.apiKeyUnusable),
              gte(bots.updatedAt, key.createdAt),
            ),
          )
          .limit(1);
  return {
    connection: {
      address: account.address,
      sodexAccountId: account.sodexAccountId.toString(),
      status: account.status,
      apiKey:
        key === undefined
          ? null
          : {
              name: key.name,
              last4: key.last4,
              status:
                key.status === "active" && key.expiresAt <= now
                  ? "expired"
                  : key.status === "active" &&
                      (pausedForKey.length > 0 ||
                        (await deps.signer.verifyApiKey(key.id)) === "unusable")
                    ? "unusable"
                    : key.status,
              expiresAt: iso(key.expiresAt),
              lastUsedAt: key.lastUsedAt === null ? null : iso(key.lastUsedAt),
              permissions: { trade: key.status === "active", withdrawTransfer: false },
            },
      builderFee: isBuilderAccount(account.sodexAccountId, deps.builderId, deps.builderExempt)
        ? {
            builderId: deps.builderId.toString(),
            spot: null,
            perps: null,
            approved: true,
            exempt: true,
            readBackAt: iso(now),
          }
        : fee === undefined
          ? null
          : {
              builderId: fee.builderId.toString(),
              spot: fee.maxFeeRateSpot,
              perps: fee.maxFeeRatePerps,
              approved:
                isBuilderFeeApproved(fee.maxFeeRateSpot) &&
                isBuilderFeeApproved(fee.maxFeeRatePerps),
              exempt: false,
              readBackAt: iso(fee.readBackAt),
            },
    },
  };
}

/** Chữ ký 1: tạo key DRIFT cho master wallet `address`. */
export async function startConnect(
  deps: SodexDeps,
  userId: string,
  address: string,
): Promise<SignatureRequest> {
  if (!deps.connectEnabled) {
    throw new AppError(ErrorCode.forbidden, "Connecting SoDEX is not enabled yet.", {
      reason: "connect_disabled",
    });
  }
  const user = getAddress(address);
  let primaryAccountID: bigint;
  try {
    primaryAccountID = (await deps.rest.getSubaccounts(user)).primaryAccountID;
  } catch (error) {
    if (error instanceof AppError && error.details.sodexError === "user not found") {
      throw new AppError(ErrorCode.sodexAccountNotFound, "No SoDEX account for this wallet.");
    }
    throw error;
  }

  const account = await upsertAccount(deps.db, userId, user, primaryAccountID);
  return withAccountLock(deps, account.id, async (tx) => {
    const open = await reusePending(deps, tx, account.id, SignatureAction.addApiKey);
    if (open !== null) return open;
    const nonce = await nextNonce(deps, tx, account.id);
    const expiresAt = nonce + DRIFT_API_KEY_TTL_MS;
    // Signer tạo key mới (#316): lỗi từ đây không giải phóng Idempotency-Key.
    markSideEffect();
    const key = await deps.signer.createApiKey({
      sodexAccountId: account.id,
      name: DRIFT_API_KEY_NAME,
      expiresAt: iso(new Date(Number(expiresAt))),
    });
    const request = addPermissionedApiKeyRequest({
      user,
      accountID: primaryAccountID,
      publicKey: getAddress(key.publicKey),
      nonce,
      expiresAt,
    });
    return insertRequest(deps, tx, userId, account.id, SignatureAction.addApiKey, request, key.id);
  });
}

/**
 * Renew key (UI_REVIEW E9 / H1, DEC-59): key mới tên `DRIFT-<yyyymmdd>` cho account đang kết nối, một chữ ký của
 * master wallet (`UserSignedAddPermissionedAPIKeyAction`, cùng quyền). Khi SoDEX xác nhận, key cũ trong DRIFT
 * chuyển `expired` (engine / signer chỉ dùng key `active`); key cũ vẫn còn trên SoDEX cho tới khi người dùng xoá.
 */
export async function startRenew(deps: SodexDeps, userId: string): Promise<SignatureRequest> {
  const account = await currentAccount(deps.db, userId);
  if (account?.status !== "connected") {
    throw new AppError(ErrorCode.stateConflict, "No connected SoDEX account to renew.");
  }
  return withAccountLock(deps, account.id, async (tx) => {
    const open = await reusePending(deps, tx, account.id, SignatureAction.addApiKey);
    if (open !== null) return open;
    const day = deps.now().toISOString().slice(0, 10).replace(/-/g, "");
    const used = new Set(
      (
        await tx
          .select({ name: apiKeys.name })
          .from(apiKeys)
          .where(eq(apiKeys.sodexAccountId, account.id))
      ).map((k) => k.name),
    );
    let name = `${DRIFT_API_KEY_NAME}-${day}`;
    for (let i = 2; used.has(name); i += 1) name = `${DRIFT_API_KEY_NAME}-${day}-${String(i)}`;
    const nonce = await nextNonce(deps, tx, account.id);
    const expiresAt = nonce + DRIFT_API_KEY_TTL_MS;
    markSideEffect();
    const key = await deps.signer.createApiKey({
      sodexAccountId: account.id,
      name,
      expiresAt: iso(new Date(Number(expiresAt))),
    });
    const request = addPermissionedApiKeyRequest({
      user: getAddress(account.address),
      accountID: account.sodexAccountId,
      publicKey: getAddress(key.publicKey),
      nonce,
      expiresAt,
      name,
    });
    return insertRequest(deps, tx, userId, account.id, SignatureAction.addApiKey, request, key.id);
  });
}

/** Chữ ký 2 (approve 50) hoặc revoke (0). Revoke cần 2FA (SCREENS.md mục 8.5). */
export async function startBuilderFee(
  deps: SodexDeps,
  userId: string,
  approve: boolean,
  twoFactorCode: string | undefined,
  ip: string | null,
  sessionId?: string,
): Promise<SignatureRequest> {
  const account = await currentAccount(deps.db, userId);
  if (account === undefined) throw new AppError(ErrorCode.notFound, "No SoDEX account connected.");
  if (!approve)
    await verifyTwoFactor(
      deps,
      userId,
      twoFactorCode,
      ip,
      sessionId === undefined ? {} : { sessionId },
    );
  const action = approve ? SignatureAction.approveBuilderFee : SignatureAction.revokeBuilderFee;
  const opposite = approve ? SignatureAction.revokeBuilderFee : SignatureAction.approveBuilderFee;
  return withAccountLock(deps, account.id, async (tx) => {
    await replaceOppositeIntent(deps, tx, account.id, opposite);
    const open = await reusePending(deps, tx, account.id, action);
    if (open !== null) return open;
    const request = approveBuilderFeeRequest({
      user: getAddress(account.address),
      accountID: account.sodexAccountId,
      builderID: deps.builderId,
      approve,
      nonce: await nextNonce(deps, tx, account.id),
    });
    markSideEffect();
    return insertRequest(deps, tx, userId, account.id, action, request, null);
  });
}

/**
 * Disconnect (DEC-31): 2FA, rồi hai request xoá key do master wallet ký (Spot, Perps). Key chỉ
 * coi là đã xoá khi đọc lại thấy nó biến mất ở CẢ HAI engine.
 */
export async function startDisconnect(
  deps: SodexDeps,
  userId: string,
  twoFactorCode: string | undefined,
  ip: string | null,
  sessionId?: string,
): Promise<{ spot: SignatureRequest; perps: SignatureRequest }> {
  const account = await currentAccount(deps.db, userId);
  if (account?.status !== "connected") {
    throw new AppError(ErrorCode.notFound, "No SoDEX account connected.");
  }
  await verifyTwoFactor(
    deps,
    userId,
    twoFactorCode,
    ip,
    sessionId === undefined ? {} : { sessionId },
  );
  const [key] = await deps.db
    .select()
    .from(apiKeys)
    .where(
      and(eq(apiKeys.sodexAccountId, account.id), inArray(apiKeys.status, ["active", "expired"])),
    )
    .orderBy(desc(apiKeys.createdAt))
    .limit(1);
  if (key === undefined) throw new AppError(ErrorCode.notFound, "No DeskLabs key to revoke.");

  // Mỗi engine: dùng lại request xoá key này còn chờ ký (#318), không có thì tạo mới.
  const create = async (tx: DbTx, engine: RevokeEngine) => {
    const action =
      engine === RevokeEngine.spot
        ? SignatureAction.revokeApiKeySpot
        : SignatureAction.revokeApiKeyPerps;
    const open = await reusePending(deps, tx, account.id, action, key.id);
    if (open !== null) return open;
    const request = revokeApiKeyRequest({
      engine,
      accountID: account.sodexAccountId,
      name: key.name,
      nonce: await nextNonce(deps, tx, account.id),
    });
    markSideEffect();
    return insertRequest(deps, tx, userId, account.id, action, request, key.id);
  };
  return withAccountLock(deps, account.id, async (tx) => {
    const spot = await create(tx, RevokeEngine.spot);
    const perps = await create(tx, RevokeEngine.perps);
    // #558 (DEC-398): ngắt SoDEX thì xoá luôn phiên rewards lưu ở server (cùng transaction).
    await removeRewardsWatch(tx, userId, "sodex_disconnect", ip);
    // #594 (DEC-404): ngắt SoDEX thì xoá luôn cảnh báo SoDEX Wealth (mốc đã lưu).
    await removeWealthWatch(tx, userId, "sodex_disconnect", ip);
    return { spot, perps };
  });
}

export async function getSignatureRequest(
  deps: SodexDeps,
  userId: string,
  id: string,
): Promise<SignatureRequest> {
  return toView(await loadRow(deps.db, userId, id));
}

/** Nhận chữ ký ví, gửi SoDEX một lần, rồi đọc lại. */
export async function submitSignature(
  deps: SodexDeps,
  userId: string,
  id: string,
  walletSignature: string,
  ip: string | null,
): Promise<SignatureRequest> {
  const row = await loadRow(deps.db, userId, id);
  if (row.status !== SignatureRequestStatus.pending) {
    throw new AppError(ErrorCode.stateConflict, "Signature request is not pending.", {
      status: row.status,
      // Bị request mới hơn thay (#318, #327): web mở lại request còn hiệu lực thay vì báo lỗi chung.
      ...(row.sodexError === SIGNATURE_REQUEST_SUPERSEDED
        ? { reason: SIGNATURE_REQUEST_SUPERSEDED }
        : {}),
    });
  }
  if (row.expiresAt <= deps.now()) {
    throw new AppError(ErrorCode.validationFailed, "Signature request expired.", {
      reason: "expired",
    });
  }
  const account = await accountById(deps.db, row.sodexAccountId);
  const request = rebuild(row, getAddress(account.address));
  let header: Hex;
  try {
    header =
      "engine" in request
        ? await verifyRevokeSignature(request, walletSignature as Hex, getAddress(account.address))
        : await verifyUniversalSignature(
            request,
            walletSignature as Hex,
            getAddress(account.address),
          );
  } catch {
    throw new AppError(
      ErrorCode.signatureInvalid,
      "Signature does not match the connected wallet.",
    );
  }

  // Từ đây request có thể đã gửi tới SoDEX: lỗi (timeout, mạng) là kết quả không rõ, đối soát bằng
  // `reconciliation`, không giải phóng Idempotency-Key (#316).
  markSideEffect();
  // Chặn gửi hai lần: chỉ một request chuyển được khỏi `pending`.
  const claimed = await deps.db
    .update(sodexSignatureRequests)
    .set({ status: SignatureRequestStatus.unknown, submittedAt: deps.now() })
    .where(
      and(
        eq(sodexSignatureRequests.id, id),
        eq(sodexSignatureRequests.status, SignatureRequestStatus.pending),
      ),
    )
    .returning({ id: sodexSignatureRequests.id });
  if (claimed.length === 0) {
    // Vừa bị thay (#327) hoặc vừa được gửi bởi lần bấm khác: đọc lại để báo đúng lý do.
    const [now] = await deps.db
      .select({ sodexError: sodexSignatureRequests.sodexError })
      .from(sodexSignatureRequests)
      .where(eq(sodexSignatureRequests.id, id))
      .limit(1);
    throw new AppError(
      ErrorCode.stateConflict,
      "Signature request is not pending.",
      now?.sodexError === SIGNATURE_REQUEST_SUPERSEDED
        ? { reason: SIGNATURE_REQUEST_SUPERSEDED }
        : {},
    );
  }

  // Universal cần X-API-Chain; xoá key là action engine (domain spot/futures), gửi DELETE.
  // SoDEX Debugger: gắn account cho lời gọi (DELETE xoá key không có địa chỉ trong đường dẫn).
  const result = await withSodexCallContext(
    { accountId: row.sodexAccountId, traceId: newTraceId() },
    () =>
      deps.writer.write(
        "engine" in request
          ? {
              path: request.path,
              method: "DELETE",
              body: request.body,
              signature: header,
              nonce: request.nonce,
              actionType: REVOKE_API_KEY_ACTION,
            }
          : {
              path: request.path,
              method: "POST",
              body: request.body,
              signature: header,
              nonce: request.nonce,
              chainId: request.chainId,
              actionType: request.primaryType,
            },
      ),
  );
  await audit(deps.db, {
    userId,
    action: auditActionFor(row.action),
    target: row.sodexAccountId,
    ip,
    metadata: { requestId: id, outcome: result.outcome },
  });

  if (result.outcome === "rejected" && REVOKE_ACTIONS.has(row.action)) {
    await deps.db
      .update(sodexSignatureRequests)
      .set({
        status: SignatureRequestStatus.failed,
        sodexError: result.sodexError,
        resolvedAt: deps.now(),
      })
      .where(eq(sodexSignatureRequests.id, id));
    return getSignatureRequest(deps, userId, id);
  }
  if (result.outcome === "rejected") {
    // SoDEX chắc chắn không nhận: key chưa từng tồn tại ở SoDEX, xoá luôn bản mã hoá của nó.
    const apiKeyId = row.apiKeyId;
    await deps.db.transaction(async (tx) => {
      await tx
        .update(sodexSignatureRequests)
        .set({
          status: SignatureRequestStatus.failed,
          sodexError: result.sodexError,
          resolvedAt: deps.now(),
          apiKeyId: null,
        })
        .where(eq(sodexSignatureRequests.id, id));
      if (apiKeyId !== null)
        await tx
          .delete(apiKeys)
          .where(and(eq(apiKeys.id, apiKeyId), eq(apiKeys.status, "pending")));
    });
    return getSignatureRequest(deps, userId, id);
  }
  // `ok` hoặc `unknown`: đọc lại mới biết chắc.
  return reconcile(deps, userId, id);
}

/**
 * Đọc lại trạng thái từ SoDEX cho request đã gửi (`unknown`). Chỉ đọc, không gửi lại. Cùng hàm với vòng đối soát nền
 * của jobs (`@drift/sodex-reconcile`, #327).
 */
export async function reconcile(
  deps: SodexDeps,
  userId: string,
  id: string,
): Promise<SignatureRequest> {
  await loadRow(deps.db, userId, id);
  return toView(await reconcileSignatureRequest(deps, id));
}

// ---------- helpers ----------

/**
 * Tạo request ký của một account lần lượt (#318): khoá advisory theo account trong transaction, để hai request
 * cùng lúc (hai Idempotency-Key khác nhau) không cùng thấy "chưa có request chờ" rồi cùng tạo. Không khoá dòng
 * `sodex_accounts`: signer ghi `api_keys` (FK tới account) trong lúc transaction này còn mở.
 */
async function withAccountLock<T>(
  deps: SodexDeps,
  sodexAccountId: string,
  fn: (tx: DbTx) => Promise<T>,
): Promise<T> {
  return deps.db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`sodex_signature:${sodexAccountId}`}))`,
    );
    return fn(tx);
  });
}

/**
 * Request `pending` cùng account + action (xoá key: cùng key) còn đủ thời gian ký thì trả lại nó (#318). Request
 * `pending` khác của action này (sắp hết hạn, hay xoá một key cũ) bị thay: chuyển `failed` (`superseded`) và xoá
 * key `pending` của nó, để không bao giờ có hai request cùng loại ký được cùng lúc. Chỉ đổi dòng còn `pending`:
 * request vừa được gửi SoDEX (đã sang `unknown`) không bị đụng tới.
 */
async function reusePending(
  deps: SodexDeps,
  tx: DbTx,
  sodexAccountId: string,
  action: SignatureAction,
  apiKeyId?: string,
): Promise<SignatureRequest | null> {
  const now = deps.now();
  const rows = await tx
    .select()
    .from(sodexSignatureRequests)
    .where(
      and(
        eq(sodexSignatureRequests.sodexAccountId, sodexAccountId),
        eq(sodexSignatureRequests.action, action),
        eq(sodexSignatureRequests.status, SignatureRequestStatus.pending),
      ),
    )
    .orderBy(desc(sodexSignatureRequests.expiresAt));
  let reuse: Row | null = null;
  for (const row of rows) {
    const usable =
      reuse === null &&
      row.expiresAt.getTime() - now.getTime() >= SIGNATURE_REQUEST_REUSE_MIN_MS &&
      (apiKeyId === undefined || row.apiKeyId === apiKeyId);
    if (usable) {
      reuse = row;
      continue;
    }
    const addKey = row.action === SignatureAction.addApiKey;
    const [gone] = await tx
      .update(sodexSignatureRequests)
      .set({
        status: SignatureRequestStatus.failed,
        sodexError: SIGNATURE_REQUEST_SUPERSEDED,
        resolvedAt: now,
        ...(addKey ? { apiKeyId: null } : {}),
      })
      .where(
        and(
          eq(sodexSignatureRequests.id, row.id),
          eq(sodexSignatureRequests.status, SignatureRequestStatus.pending),
        ),
      )
      .returning({ id: sodexSignatureRequests.id });
    // Key do signer tạo cho request này chưa từng tới SoDEX: xoá như khi SoDEX từ chối.
    if (gone !== undefined && addKey && row.apiKeyId !== null)
      await tx
        .delete(apiKeys)
        .where(and(eq(apiKeys.id, row.apiKeyId), eq(apiKeys.status, "pending")));
  }
  return reuse === null ? null : toView(reuse);
}

/**
 * Mỗi account chỉ có MỘT ý định builder-fee chờ ký (#327, bổ sung DEC-336): tạo approve thì revoke còn `pending`
 * chuyển `failed` (`superseded`), và ngược lại, dưới cùng khoá advisory và trong cùng transaction với request mới.
 * Đổi trước rồi mới kiểm request đang gửi: claim `pending` → `unknown` của `submitSignature` là UPDATE có điều kiện
 * nên hoặc nó thắng (dòng đã `unknown`, không bị đổi và lần SELECT sau thấy nó), hoặc UPDATE này thắng (claim không
 * còn dòng `pending`, người ký nhận `STATE_CONFLICT`).
 *
 * Request ngược chiều đã gửi SoDEX mà chưa rõ kết quả (`unknown`) thì không thay: nó vẫn có thể được SoDEX áp dụng
 * SAU ý định mới và đè lên ý định đó. Trả `STATE_CONFLICT` (`builder_fee_in_flight`) tới khi đối soát xong (quy tắc
 * 1.7), hoặc tới khi nonce của nó ra khỏi cửa sổ SoDEX nhận (SODEX.md mục 5.6) và không thể được áp dụng nữa.
 */
async function replaceOppositeIntent(
  deps: SodexDeps,
  tx: DbTx,
  sodexAccountId: string,
  opposite: SignatureAction,
): Promise<void> {
  const now = deps.now();
  await tx
    .update(sodexSignatureRequests)
    .set({
      status: SignatureRequestStatus.failed,
      sodexError: SIGNATURE_REQUEST_SUPERSEDED,
      resolvedAt: now,
    })
    .where(
      and(
        eq(sodexSignatureRequests.sodexAccountId, sodexAccountId),
        eq(sodexSignatureRequests.action, opposite),
        eq(sodexSignatureRequests.status, SignatureRequestStatus.pending),
      ),
    );
  const oldestAcceptedNonce = now.getTime() - SODEX_NONCE_WINDOW_MS;
  const [inFlight] = await tx
    .select({ id: sodexSignatureRequests.id })
    .from(sodexSignatureRequests)
    .where(
      and(
        eq(sodexSignatureRequests.sodexAccountId, sodexAccountId),
        eq(sodexSignatureRequests.action, opposite),
        eq(sodexSignatureRequests.status, SignatureRequestStatus.unknown),
        sql`(${sodexSignatureRequests.message}->>'nonce')::numeric > ${oldestAcceptedNonce}`,
      ),
    )
    .limit(1);
  if (inFlight !== undefined) {
    throw new AppError(
      ErrorCode.stateConflict,
      "The previous builder fee change is still being confirmed with SoDEX.",
      { reason: BUILDER_FEE_IN_FLIGHT, requestId: inFlight.id },
    );
  }
}

/**
 * Nonce của master wallet: ms hiện tại, nhưng luôn lớn hơn nonce đã dùng cho account này, để hai
 * request ký liền nhau (cùng ms) không trùng nonce (SODEX.md mục 5.6).
 */
async function nextNonce(deps: SodexDeps, db: DbTx, sodexAccountId: string): Promise<bigint> {
  const now = BigInt(deps.now().getTime());
  const [row] = await db
    .select({
      max: sql<string | null>`max((${sodexSignatureRequests.message}->>'nonce')::numeric)::text`,
    })
    .from(sodexSignatureRequests)
    .where(eq(sodexSignatureRequests.sodexAccountId, sodexAccountId));
  const last = row?.max == null ? null : BigInt(row.max);
  return last !== null && last >= now ? last + 1n : now;
}

async function currentAccount(db: Db, userId: string) {
  const [account] = await db
    .select()
    .from(sodexAccounts)
    .where(and(eq(sodexAccounts.userId, userId), ne(sodexAccounts.status, "disconnected")))
    .orderBy(desc(sodexAccounts.createdAt))
    .limit(1);
  return account;
}

async function accountById(db: Db, id: string) {
  const [account] = await db.select().from(sodexAccounts).where(eq(sodexAccounts.id, id)).limit(1);
  if (account === undefined) throw new AppError(ErrorCode.notFound, "SoDEX account not found.");
  return account;
}

async function upsertAccount(db: Db, userId: string, address: Address, accountId: bigint) {
  const [existing] = await db
    .select()
    .from(sodexAccounts)
    .where(and(eq(sodexAccounts.network, "mainnet"), eq(sodexAccounts.sodexAccountId, accountId)))
    .limit(1);
  if (existing !== undefined) {
    if (existing.userId === userId) return existing;
    // Chỉ chặn khi một tài khoản DRIFT khác (chưa xoá) đang giữ kết nối. Account đã Disconnect (key của DRIFT
    // đã bị xoá phía SoDEX) hoặc thuộc tài khoản đã xoá thì chuyển cho người đang kết nối (DEC-45).
    const [owner] = await db
      .select({ deletedAt: users.deletedAt })
      .from(users)
      .where(eq(users.id, existing.userId))
      .limit(1);
    const held = existing.status !== "disconnected" && owner?.deletedAt === null;
    if (held) {
      throw new AppError(
        ErrorCode.sodexAccountInUse,
        "This SoDEX account is connected to another DeskLabs user.",
      );
    }
    const [moved] = await db
      .update(sodexAccounts)
      .set({ userId, address, status: "connecting" })
      .where(eq(sodexAccounts.id, existing.id))
      .returning();
    if (moved === undefined) throw new AppError(ErrorCode.internal, "Could not update account.");
    return moved;
  }
  // #326: hai lần Connect đầu tiên chạy song song cùng thấy "chưa có account" ở trên; bên ghi sau đụng unique index
  // (network, sodex_account_id). Không để lỗi DB thành 500: bên thua nhận 409, chưa tạo key hay request ký nào (chưa
  // gọi `markSideEffect`, nên Idempotency-Key được giải phóng). Thử lại thì đi nhánh `existing` ở trên.
  const [created] = await db
    .insert(sodexAccounts)
    .values({
      userId,
      address,
      sodexAccountId: accountId,
      network: "mainnet",
      status: "connecting",
    })
    .onConflictDoNothing({ target: [sodexAccounts.network, sodexAccounts.sodexAccountId] })
    .returning();
  if (created === undefined) {
    throw new AppError(
      ErrorCode.stateConflict,
      "Another Connect for this SoDEX account is in progress. Try again in a moment.",
      { reason: "connect_in_progress" },
    );
  }
  return created;
}

async function insertRequest(
  deps: SodexDeps,
  db: DbTx,
  userId: string,
  sodexAccountId: string,
  action: SignatureAction,
  request: AnyRequest | RevokeKeyRequest,
  apiKeyId: string | null,
): Promise<SignatureRequest> {
  const [row] = await db
    .insert(sodexSignatureRequests)
    .values({
      userId,
      sodexAccountId,
      action,
      apiKeyId,
      // Lưu đủ để dựng lại đúng request; `nonce` luôn có để tính nonce kế tiếp.
      message:
        "engine" in request
          ? {
              accountID: request.accountID.toString(),
              name: request.name,
              nonce: request.nonce.toString(),
            }
          : wireTypedData(request).message,
      status: SignatureRequestStatus.pending,
      expiresAt: new Date(deps.now().getTime() + SIGNATURE_REQUEST_TTL_MS),
    })
    .returning();
  if (row === undefined)
    throw new AppError(ErrorCode.internal, "Could not create signature request.");
  return toView(row);
}

async function loadRow(db: Db, userId: string, id: string): Promise<Row> {
  const [row] = await db
    .select()
    .from(sodexSignatureRequests)
    .where(and(eq(sodexSignatureRequests.id, id), eq(sodexSignatureRequests.userId, userId)))
    .limit(1);
  if (row === undefined) throw new AppError(ErrorCode.notFound, "Signature request not found.");
  return row;
}

/** Dựng lại request từ message đã lưu, nên chữ ký luôn được kiểm tra trên đúng message server dựng. */
function rebuild(row: Row, user: Address): AnyRequest | RevokeKeyRequest {
  if (REVOKE_ACTIONS.has(row.action)) {
    const m = revokeMessageSchema.parse(row.message);
    return revokeApiKeyRequest({
      engine:
        row.action === SignatureAction.revokeApiKeySpot ? RevokeEngine.spot : RevokeEngine.perps,
      accountID: m.accountID,
      name: m.name,
      nonce: m.nonce,
    });
  }
  if (row.action === SignatureAction.addApiKey) {
    const m = addKeyMessageSchema.parse(row.message);
    return addPermissionedApiKeyRequest({
      user,
      accountID: m.accountID,
      publicKey: getAddress(m.publicKey),
      nonce: m.nonce,
      expiresAt: m.expiresAt,
      name: m.name,
    });
  }
  const m = approveMessageSchema.parse(row.message);
  return approveBuilderFeeRequest({
    user,
    accountID: m.accountID,
    builderID: m.builderID,
    approve: m.maxFeeRate !== 0n,
    nonce: m.nonce,
  });
}

function toView(row: Row): SignatureRequest {
  // Chỉ cần typed data; path (có địa chỉ ví) không dùng ở đây.
  const request = rebuild(row, "0x0000000000000000000000000000000000000000");
  return {
    id: row.id,
    action: row.action,
    status: row.status,
    typedData: "engine" in request ? wireRevokeTypedData(request) : wireTypedData(request),
    expiresAt: iso(row.expiresAt),
    sodexError: row.sodexError,
  };
}

function auditActionFor(action: SignatureAction): AuditAction {
  switch (action) {
    case SignatureAction.addApiKey:
      return AuditAction.apiKeyAdded;
    case SignatureAction.approveBuilderFee:
      return AuditAction.builderFeeApproved;
    case SignatureAction.revokeBuilderFee:
      return AuditAction.builderFeeRevoked;
    case SignatureAction.revokeApiKeySpot:
    case SignatureAction.revokeApiKeyPerps:
      return AuditAction.apiKeyRevoked;
  }
}
