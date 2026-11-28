import type { Db } from "@drift/db";
import { auditLog } from "@drift/db";

// Mọi thao tác nhạy cảm ghi audit (DOMAIN.md 7.5). `metadata` không bao giờ chứa secret hay chữ ký.

export const AuditAction = {
  signIn: "auth.sign_in",
  signOut: "auth.sign_out",
  sessionRevoked: "security.session_revoked",
  twoFactorEnabled: "security.2fa_enabled",
  backupCodeUsed: "security.backup_code_used",
  apiKeyAdded: "sodex.api_key_added",
  builderFeeApproved: "sodex.builder_fee_approved",
  builderFeeRevoked: "sodex.builder_fee_revoked",
  apiKeyRevoked: "sodex.api_key_revoked",
  disconnected: "sodex.disconnected",
  botCreated: "bot.created",
  botStarted: "bot.started",
  botStopped: "bot.stopped",
  riskLimitChanged: "risk.limit_changed",
  emergencyHalt: "risk.emergency_halt",
  accountDeleted: "account.deleted",
  passwordResetByTeam: "admin.password_reset",
  volumeBotsChanged: "admin.volume_bots",
  aiDeskChanged: "admin.ai_desk",
  adaptiveDcaChanged: "admin.adaptive_dca",
  /** #423: team bật / tắt Signal Research (BETA) cho một user. */
  signalResearchChanged: "admin.signal_research",
  builderFeeChanged: "admin.builder_fee",
  adminUserViewed: "admin.user_viewed",
  telegramConnected: "telegram.connected",
  telegramDisconnected: "telegram.disconnected",
  /** Team xem dữ liệu một user qua MCP nội bộ (DEC-220): target = user, metadata có tool + tokenId. */
  mcpTeamUserViewed: "mcp.team_user_viewed",
  /** #420: Close now / Edit TP/SL trên lệnh của bot `news_signal` (target = trade, metadata có command id, seq). */
  newsTradeClose: "news_signal.close",
  newsTradeEditTpsl: "news_signal.edit_tpsl",
  /** #558 (DEC-398): bật / tắt báo box mới SoDEX rewards. metadata không bao giờ chứa token. */
  rewardsWatchEnabled: "rewards.watch_enabled",
  rewardsWatchDisabled: "rewards.watch_disabled",
  /** #594 (DEC-404): bật / tắt cảnh báo SoDEX Wealth. metadata không chứa địa chỉ ví. */
  wealthWatchEnabled: "wealth.watch_enabled",
  wealthWatchDisabled: "wealth.watch_disabled",
} as const;
export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];

export async function audit(
  db: Pick<Db, "insert">,
  entry: {
    userId: string | null;
    action: AuditAction;
    target?: string;
    metadata?: Record<string, unknown>;
    ip: string | null;
  },
): Promise<void> {
  await db.insert(auditLog).values({
    userId: entry.userId,
    action: entry.action,
    target: entry.target ?? null,
    metadata: entry.metadata ?? {},
    ip: entry.ip,
  });
}
