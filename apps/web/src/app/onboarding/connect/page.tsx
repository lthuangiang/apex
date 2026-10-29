import { useTranslations } from "next-intl";

import { ConnectSodex, OnboardingShell } from "@/features/onboarding";

export default function ConnectPage() {
  const t = useTranslations("onboarding.connect");
  return (
    <OnboardingShell current={2} safety={t("safety")}>
      <ConnectSodex />
    </OnboardingShell>
  );
}
