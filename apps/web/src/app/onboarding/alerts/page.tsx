import { useTranslations } from "next-intl";
import { Suspense } from "react";

import { OnboardingShell, TelegramStep } from "@/features/onboarding";

// Bước tuỳ chọn sau "Strategy plan": cảnh báo trên Telegram (DEC-202). Không đánh số trong 6 bước.
export default function AlertsPage() {
  const t = useTranslations("onboarding.alerts");
  return (
    <OnboardingShell current={6} noSteps safety={t("safety")}>
      <Suspense>
        <TelegramStep />
      </Suspense>
    </OnboardingShell>
  );
}
