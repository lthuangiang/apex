import { users, type Db } from "@drift/db";
import { AppError, ErrorCode, UserRole } from "@drift/shared";
import { eq } from "drizzle-orm";

/** Chặn mọi thao tác của trang Users / Stats / Builder Revenue cho người không thuộc role `team`. */
export async function requireTeam(db: Db, userId: string, message: string): Promise<void> {
  const [u] = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (u?.role !== UserRole.team) throw new AppError(ErrorCode.forbidden, message);
}
