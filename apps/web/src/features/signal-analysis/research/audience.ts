"use client";

import { createContext, useContext } from "react";

// Người xem của trang Signal research (#423, DEC-TBD-sr-menu-beta). Cùng một bộ component cho trang team (Signal Analysis ›
// Signal research) và trang Signal Research BETA ngoài /admin; chỉ khác ở vài phần chỉ team:
// - `team`: như trước (mọi phần).
// - `tester`: người dùng có cờ `users.signal_research`. Ẩn ô Claude cost và mọi chi phí / token Claude, ô độ trễ theo chặng
//   ("Where the time goes", API chỉ team); version của team chỉ xem, version của chính họ ở nhóm My versions.
// API vẫn tự kiểm quyền và bỏ dữ liệu chỉ team; context này chỉ để không vẽ ô "Not available" thay cho phần bị ẩn.

export type ResearchAudience = "team" | "tester";

export const ResearchAudienceContext = createContext<ResearchAudience>("team");

export function useResearchAudience(): ResearchAudience {
  return useContext(ResearchAudienceContext);
}

/** Người xem thấy chi phí / token Claude (chỉ team). */
export function useShowsClaudeCost(): boolean {
  return useResearchAudience() === "team";
}
