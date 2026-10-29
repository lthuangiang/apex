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
