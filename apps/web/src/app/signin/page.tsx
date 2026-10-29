import Link from "next/link";
import { useTranslations } from "next-intl";

import { EmailSignIn } from "@/features/auth";
import { OnboardingShell } from "@/features/onboarding";

export default function SigninPage() {
  const t = useTranslations("onboarding.signup");
  return (
    <OnboardingShell
      current={1}
      noSteps
      safety={t("safety")}
      topRight={
        <span className="text-sm text-ink-2">
          {t("noAccount")}&#160;
          <Link href="/signup" className="font-bold text-accent no-underline">
            {t("createAccount")}
          </Link>
        </span>
      }
    >
      <EmailSignIn mode="signin" />
    </OnboardingShell>
  );
}
