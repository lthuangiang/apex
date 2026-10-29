import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { SignOutButton } from "@/components/sign-out";

// Khung chung của onboarding (artboard "Onboarding 1 · Create account" / "Onboarding 2"):
// rail các bước bên trái, nội dung bên phải; < 768px chỉ còn thanh tiến độ (artboard Mobile · Onboarding).

const STEPS = ["account", "connect", "import", "analysis", "goals", "plan"] as const;

export function OnboardingShell({
  current,
  safety,
  topRight,
  wide = false,
  railPanel,
  noSteps = false,
  children,
}: {
  current: 1 | 2 | 3 | 4 | 5 | 6;
  /** Sign in không phải bước onboarding (UI_REVIEW E11): ẩn rail 6 bước và thanh tiến độ, form ở giữa. */
  noSteps?: boolean;
  safety: string;
  topRight?: ReactNode;
  /** Màn phân tích cần rộng hơn (artboard Onboarding 4). */
  wide?: boolean;
  /** Bước 5–6: khối tóm tắt trong rail (artboard "From your analysis" / "Your answers"). */
  railPanel?: ReactNode;
  children: ReactNode;
}) {
  const t = useTranslations("onboarding.rail");
  const tc = useTranslations("common");
  return (
    <div className="flex min-h-screen flex-wrap items-stretch gap-5 bg-bg p-0 md:p-5">
      <aside
        className={`relative hidden flex-[1_1_340px] flex-col gap-7 overflow-hidden rounded-hero bg-hero px-7 py-8 ${noSteps ? "" : "md:flex"}`}
      >
        <Brand label={tc("brand")} />
        <div className="flex flex-col gap-2">
          <h2 className="m-0 text-2xl leading-tight font-extrabold">{t("title")}</h2>
          <p className="m-0 text-sm leading-relaxed text-ink-2">{t("body")}</p>
        </div>
        <ol aria-label={t("label")} className="m-0 flex list-none flex-col gap-1.5 p-0">
          {STEPS.map((key, i) => {
            const n = i + 1;
            const on = n === current;
            const done = n < current;
            return (
              <li
                key={key}
                aria-current={on ? "step" : undefined}
                className={`flex items-center gap-3 rounded-tile px-3 py-2.5 ${on ? "bg-surface shadow-sm" : ""}`}
              >
                <span
                  aria-hidden="true"
                  className={`flex size-[30px] flex-none items-center justify-center rounded-full text-[13px] font-extrabold ${
                    on
                      ? "bg-accent text-surface"
                      : done
                        ? "bg-pos-bg text-pos"
                        : "bg-surface/70 text-ink-2"
                  }`}
                >
                  {done ? "✓" : n}
                </span>
                <span className="flex flex-col">
                  <span className="text-sm font-bold">{t(`steps.${key}.label`)}</span>
                  <span className="text-xs text-ink-2">{t(`steps.${key}.sub`)}</span>
                </span>
              </li>
            );
          })}
        </ol>
        {railPanel === undefined ? null : (
          <section className="flex flex-col gap-2 rounded-tile bg-surface/85 p-4 text-[13px] leading-normal tabular-nums">
            {railPanel}
          </section>
        )}
        <p className="mt-auto flex gap-2.5 rounded-tile bg-surface/80 p-3.5 text-[13px] leading-normal text-ink-2">
          <LockIcon />
          <span>{safety}</span>
        </p>
      </aside>
      <main className="flex min-w-0 flex-[999_1_560px] justify-center bg-surface md:rounded-hero md:border md:border-border">
        <div
          className={`flex w-full ${wide ? "max-w-[1080px]" : "max-w-[520px]"} flex-col gap-6 px-5 py-6 md:px-6 md:py-12`}
        >
          <div
            className={`flex items-center justify-between gap-3 ${noSteps ? "" : "md:justify-end"}`}
          >
            <span className={noSteps ? "" : "md:hidden"}>
              <Brand label={tc("brand")} />
            </span>
            {topRight}
            {/* Bước 1 (đăng ký) chưa có phiên; từ bước 2 có thể đăng xuất để đổi tài khoản. */}
            {current >= 2 ? <SignOutButton /> : null}
          </div>
          {noSteps ? null : (
            <div
              role="progressbar"
              aria-label={t("stepOf", { step: current })}
              aria-valuenow={current}
              aria-valuemin={1}
              aria-valuemax={6}
              className="flex gap-1 md:hidden"
            >
              {STEPS.map((key, i) => (
                <span
                  key={key}
                  className={`h-[5px] flex-1 rounded-full ${i + 1 < current ? "bg-pos-dot" : i + 1 === current ? "bg-accent" : "bg-border-input"}`}
                />
              ))}
            </div>
          )}
          {children}
          {noSteps ? (
            <p className="m-0 flex gap-2.5 rounded-tile bg-surface-2 p-3.5 text-[13px] leading-normal text-ink-2">
              <LockIcon />
              <span>{safety}</span>
            </p>
          ) : null}
        </div>
      </main>
    </div>
  );
}

export function StepHeading({
  step,
  title,
  lead,
}: {
  /** Không có = màn không thuộc onboarding (Sign in): không hiện "STEP x OF 6". */
  step?: number;
  title: string;
  lead?: string;
}) {
  const t = useTranslations("onboarding.rail");
  return (
    <div className="flex flex-col gap-2">
      {step === undefined ? null : (
        <span className="text-xs font-extrabold tracking-[0.08em] text-accent">
          {t("stepOf", { step })}
        </span>
      )}
      <h1 className="m-0 text-[26px] font-extrabold tracking-tight md:text-[30px]">{title}</h1>
      {lead === undefined ? null : (
        <p className="m-0 text-sm leading-relaxed text-ink-2 md:text-[15px]">{lead}</p>
      )}
    </div>
  );
}

function Brand({ label }: { label: string }) {
  return (
    <span className="flex items-center gap-2.5">
      <span className="flex size-10 items-center justify-center rounded-control bg-accent text-surface">
        <svg
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M4 15c3-6 6 2 9-3s5-5 7-4" />
          <path d="M4 20h16" />
        </svg>
      </span>
      <span className="text-xl font-extrabold tracking-[0.06em]">{label}</span>
    </span>
  );
}

function LockIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="mt-px flex-none text-accent"
    >
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}
