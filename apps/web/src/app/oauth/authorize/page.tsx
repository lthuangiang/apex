import { useTranslations } from "next-intl";
import { Suspense } from "react";

import { ConsentPage } from "@/features/oauth";
import { OnboardingShell } from "@/features/onboarding";

// Màn consent OAuth cho MCP (authorization_endpoint, DEC-215).
export default function OauthAuthorizePage() {
  const t = useTranslations("onboarding.signup");
  return (
    <OnboardingShell current={1} noSteps safety={t("safety")}>
      <Suspense>
        <ConsentPage />
      </Suspense>
    </OnboardingShell>
  );
}
