import { type Db } from "@drift/db";
import type { ArchitectureMap } from "@drift/shared";

import { ARCHITECTURE_MAP } from "./architecture-data";
import { requireTeam } from "./team";

// System Architecture Diagram (team): nội dung chỉ trả cho role team (DevOps, PR #211: chi tiết hạ tầng không được
// gửi xuống mọi trình duyệt). Người không thuộc team nhận 403, chưa đăng nhập nhận 401 (requireAuth ở route).
export async function architectureMap(db: Db, userId: string): Promise<ArchitectureMap> {
  await requireTeam(db, userId, "System Architecture Diagram is for the DeskLabs team only.");
  return ARCHITECTURE_MAP;
}
