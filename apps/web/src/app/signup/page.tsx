import Link from "next/link";
import { useTranslations } from "next-intl";

import { EmailSignIn } from "@/features/auth";
import { OnboardingShell } from "@/features/onboarding";

export default function SignupPage() {
  const t = useTranslations("onboarding.signup");
  return (
    <OnboardingShell
      current={1}
      safety={t("safety")}
      topRight={
        <span className="text-sm text-ink-2">
          {t("haveAccount")}&#160;
          <Link href="/signin" className="font-bold text-accent no-underline">
            {t("signIn")}
          </Link>
        </span>
      }
    >
      <EmailSignIn mode="signup" />
    </OnboardingShell>
  );
}
