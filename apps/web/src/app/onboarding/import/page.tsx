import { useTranslations } from "next-intl";

import { ImportProgress, OnboardingShell } from "@/features/onboarding";

export default function ImportPage() {
  const t = useTranslations("onboarding.signup");
  return (
    <OnboardingShell current={3} safety={t("safety")}>
      <ImportProgress />
    </OnboardingShell>
  );
}
