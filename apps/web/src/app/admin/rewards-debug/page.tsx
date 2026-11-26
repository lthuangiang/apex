import { RewardsDebugPage } from "@/features/rewards";

// Chẩn đoán SoDEX rewards (#547, chỉ team; không có mục sidebar). Chạy cả khi công tắc REWARDS_ENABLED tắt (DEC-397).
export default function Page() {
  return <RewardsDebugPage />;
}
