import { RewardsPage } from "@/features/rewards";

// SoDEX rewards (DEC-397, #548): sau công tắc toàn hệ thống `sodexRewards`; tắt thì Not found như route chưa có.
export default function Page() {
  return <RewardsPage />;
}
