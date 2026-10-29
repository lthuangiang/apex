"use client";

import {
  meSchema,
  PASSWORD_MIN_LENGTH,
  passwordContainsEmail,
  sodexConnectionSchema,
} from "@drift/shared";
import { Button, inputClassName } from "@drift/ui";
import { Eye, EyeOff } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useId, useRef, useState } from "react";

import { StepHeading } from "@/features/onboarding";
import { api, ApiError } from "@/lib/api";

// Onboarding 1: email + mật khẩu (DEC-76, thay luồng mã OTP qua email của DEC-28 khi production chưa có
// SMTP; artboard "Onboarding 1 · Create account" vốn có ô mật khẩu + quy tắc). Cùng một form cho
// "Create account" (có checkbox Risk Disclosure) và "Sign in" (hỏi thêm mã 2FA nếu account đã bật).

export function EmailSignIn({ mode }: { mode: "signup" | "signin" }) {
  const t = useTranslations("onboarding.signup");
  const tc = useTranslations("common.errors");
  const router = useRouter();
  const ids = {
    email: useId(),
    password: useId(),
    rules: useId(),
    tfa: useId(),
    terms: useId(),
    error: useId(),
  };

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [needsTwoFactor, setNeedsTwoFactor] = useState(false);
  const [twoFactorCode, setTwoFactorCode] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Bấm lại khi đang chờ không tạo request mới.
  const inFlight = useRef(false);

  const longEnough = password.length >= PASSWORD_MIN_LENGTH;
  const notEmail = password.length > 0 && !passwordContainsEmail(password, email);
  const rulesOk = longEnough && notEmail;

  const describe = (e: unknown): string => {
    if (!(e instanceof ApiError)) return tc("generic");
    const messages: Partial<Record<ApiError["code"], string>> = {
      INVALID_CREDENTIALS: t("errors.invalidCredentials"),
      EMAIL_TAKEN: t("errors.emailTaken"),
      VALIDATION_FAILED: mode === "signup" ? t("errors.passwordRules") : tc("generic"),
      TWO_FACTOR_INVALID: t("errors.twoFactorInvalid"),
      RATE_LIMITED: mode === "signin" ? t("errors.locked") : tc("rateLimited"),
      NETWORK: tc("network"),
    };
    return messages[e.code] ?? tc("generic");
  };

  const submit = (event: { preventDefault: () => void }) => {
    event.preventDefault();
    if (mode === "signup" && !agreed) {
      setError(t("errors.terms"));
      return;
    }
    if (mode === "signup" && !rulesOk) {
      setError(t("errors.passwordRules"));
      return;
    }
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    void (async () => {
      try {
        if (mode === "signup") {
          await api("POST", "/api/v1/auth/register", meSchema, { body: { email, password } });
          router.push("/onboarding/connect");
          return;
        }
        await api("POST", "/api/v1/auth/login", meSchema, {
          body: { email, password, ...(needsTwoFactor ? { twoFactorCode } : {}) },
        });
        const { connection } = await api("GET", "/api/v1/sodex/connection", sodexConnectionSchema);
        router.push(connection?.status === "connected" ? "/" : "/onboarding/connect");
      } catch (e) {
        if (e instanceof ApiError && e.code === "TWO_FACTOR_REQUIRED") {
          setNeedsTwoFactor(true);
          return;
        }
        setError(describe(e));
      } finally {
        inFlight.current = false;
        setPending(false);
      }
    })();
  };

  const invalid = error === null ? {} : { "aria-describedby": ids.error, "aria-invalid": true };

  return (
    <>
      <StepHeading
        {...(mode === "signup" ? { step: 1 } : {})}
        title={mode === "signup" ? t("title") : t("signInTitle")}
      />
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        <label htmlFor={ids.email} className="flex flex-col gap-1.5">
          <span className="text-[13px] font-bold">{t("email")}</span>
          <input
            id={ids.email}
            className={inputClassName}
            type="email"
            autoComplete={mode === "signup" ? "email" : "username"}
            placeholder={t("emailPlaceholder")}
            required
            value={email}
            readOnly={needsTwoFactor}
            onChange={(e) => {
              setEmail(e.target.value);
            }}
          />
        </label>

        <div className="flex flex-col gap-1.5">
          <label htmlFor={ids.password} className="text-[13px] font-bold">
            {t("password")}
          </label>
          <div className="flex items-center rounded-control border border-border-input bg-surface pr-1.5 pl-3.5 focus-within:outline-3 focus-within:outline-offset-2 focus-within:outline-focus">
            <input
              id={ids.password}
              type={showPassword ? "text" : "password"}
              autoComplete={mode === "signup" ? "new-password" : "current-password"}
              required
              value={password}
              readOnly={needsTwoFactor}
              onChange={(e) => {
                setPassword(e.target.value);
              }}
              className="min-h-12 min-w-0 flex-1 border-none bg-transparent text-[15px] text-ink outline-none"
              {...(mode === "signup" ? { "aria-describedby": ids.rules } : invalid)}
            />
            <button
              type="button"
              aria-label={showPassword ? t("passwordHide") : t("passwordShow")}
              aria-pressed={showPassword}
              onClick={() => {
                setShowPassword(!showPassword);
              }}
              className="flex size-10 flex-none items-center justify-center rounded-[10px] text-ink-2 hover:bg-surface-2"
            >
              {showPassword ? (
                <EyeOff size={18} aria-hidden="true" />
              ) : (
                <Eye size={18} aria-hidden="true" />
              )}
            </button>
          </div>
          {mode === "signup" ? (
            <ul
              id={ids.rules}
              className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1.5 p-0 text-xs font-semibold"
            >
              <li className={longEnough ? "text-fits" : "text-muted"}>
                {longEnough ? "✓" : "○"} {t("rules.length")}
              </li>
              <li className={notEmail ? "text-fits" : "text-muted"}>
                {notEmail ? "✓" : "○"} {t("rules.email")}
              </li>
            </ul>
          ) : null}
        </div>

        {needsTwoFactor ? (
          <label htmlFor={ids.tfa} className="flex flex-col gap-1.5">
            <span className="text-[13px] font-bold">{t("twoFactorLabel")}</span>
            <span className="text-xs text-muted">{t("twoFactorBody")}</span>
            <input
              id={ids.tfa}
              className={inputClassName}
              autoComplete="one-time-code"
              required
              value={twoFactorCode}
              onChange={(e) => {
                setTwoFactorCode(e.target.value.trim());
              }}
            />
          </label>
        ) : null}

        {mode === "signup" ? (
          <label
            htmlFor={ids.terms}
            className="flex cursor-pointer items-start gap-2.5 text-[13px] leading-normal text-ink-2"
          >
            <input
              id={ids.terms}
              type="checkbox"
              checked={agreed}
              onChange={(e) => {
                setAgreed(e.target.checked);
              }}
              className="mt-0.5 size-[18px] flex-none accent-accent"
            />
            <span>
              {t.rich("terms", {
                // Tab mới để không mất email đã nhập. DRIFT là app cá nhân: chỉ có Risk Disclosure (UI_REVIEW L).
                risk: (chunks) => (
                  <a
                    href="/risk-disclosure"
                    target="_blank"
                    rel="noopener"
                    className="font-bold text-accent"
                  >
                    {chunks}
                  </a>
                ),
              })}
            </span>
          </label>
        ) : null}

        {error === null ? null : (
          <p
            id={ids.error}
            role="alert"
            className="m-0 rounded-control bg-neg-bg px-3.5 py-3 text-sm font-semibold text-neg-ink"
          >
            {error}
          </p>
        )}

        <Button
          type="submit"
          pending={pending}
          disabled={
            email.trim() === "" || password === "" || (needsTwoFactor && twoFactorCode === "")
          }
        >
          {mode === "signup"
            ? t("submit")
            : needsTwoFactor
              ? t("twoFactorSubmit")
              : t("signInSubmit")}
        </Button>
        <p className="m-0 text-xs leading-normal text-muted">
          {mode === "signup" ? t("note") : t("forgot")}
        </p>
      </form>
    </>
  );
}
