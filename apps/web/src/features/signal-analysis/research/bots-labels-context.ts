"use client";

import { createContext, useContext } from "react";

// Hành động mở khu "Bots & labels" (cuối trang Signal research) từ chỗ khác: dải tóm tắt, Is it working?, thanh version.
// Tách file riêng để versions.tsx / is-it-working.tsx dùng được mà không tạo vòng import với bots-labels.tsx.

export interface BotsLabelsActions {
  /** Mở khu và cuộn tới đầu khu. */
  openVersions: () => void;
  /** Mở khu, bắt đầu "Label signals" (bài ngẫu nhiên) và cuộn tới. */
  openLabels: () => void;
}

const BotsLabelsContext = createContext<BotsLabelsActions | null>(null);
export const BotsLabelsProvider = BotsLabelsContext.Provider;
/** null ngoài provider (component đứng riêng trong test). */
export const useBotsLabels = () => useContext(BotsLabelsContext);
