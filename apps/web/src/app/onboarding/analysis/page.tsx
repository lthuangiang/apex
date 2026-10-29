import { useTranslations } from "next-intl";

import { AnalysisReport, OnboardingShell } from "@/features/onboarding";

export default function AnalysisPage() {
  const t = useTranslations("onboarding.signup");
  return (
    <OnboardingShell current={4} safety={t("safety")} wide>
      <AnalysisReport />
    </OnboardingShell>
  );
}
