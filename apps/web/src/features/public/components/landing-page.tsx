import { DRIFT_BUILDER_FEE_RATE } from "@drift/shared";
import {
  ArrowRight,
  Bot,
  Check,
  ChevronDown,
  CircleX,
  Lock,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { feeLabels } from "@/lib/format";

import { PublicHeader } from "./public-header";
import { StrategyGrid } from "./strategy-grid";

// Landing khi chưa đăng nhập (artboard "Landing · Public", UI_REVIEW mục K). Trang tĩnh: không gọi API,
// không có số liệu marketing (quy tắc 1.8). Hình thẻ Trading Agent là minh hoạ, không có số tiền.

const SECTION = "mx-auto box-border w-full max-w-[1240px]";
const EYEBROW = "text-xs font-extrabold tracking-[0.08em]";
const H2 = "m-0 text-[clamp(28px,3.4vw,40px)] leading-[1.15] font-extrabold tracking-[-0.01em]";

export function LandingPage() {
  const t = useTranslations("landing");
  const { pct } = feeLabels(DRIFT_BUILDER_FEE_RATE);
  const steps = ["connect", "import", "plan", "run"] as const;
  const faq = ["withdraw", "sign", "suggest", "paper", "halt"] as const;

  return (
    <div className="flex flex-col gap-5 bg-bg p-4 md:p-5">
      <PublicHeader withNav />

      <main className="flex flex-col gap-5">
        <section
          id="top"
          className={`${SECTION} relative flex flex-wrap items-center gap-12 overflow-hidden rounded-[32px] bg-hero px-[clamp(20px,5vw,64px)] py-[clamp(32px,6vw,72px)]`}
        >
          <Rings className="absolute -top-40 -right-44 size-[520px] opacity-55" />
          <div className="relative flex min-w-0 flex-[1_1_460px] flex-col gap-6">
            <span
              className={`${EYEBROW} self-start rounded-full bg-surface/85 px-3 py-1.5 text-accent`}
            >
              {t("hero.eyebrow")}
            </span>
            <h1 className="m-0 text-[clamp(36px,5.2vw,64px)] leading-[1.05] font-extrabold tracking-[-0.02em]">
              {t("hero.titleTop")}
              <br />
              {t("hero.titleBottom")}
            </h1>
            <p className="m-0 max-w-[540px] text-lg leading-relaxed text-ink-body">
              {t("hero.body")}
            </p>
            <div className="flex flex-wrap gap-3">
              <Link
                href="/signup"
                className="flex min-h-[52px] items-center gap-2 rounded-tile bg-accent px-6 text-base font-bold text-surface no-underline shadow-accent hover:brightness-95"
              >
                {t("nav.createAccount")}
                <ArrowRight size={18} aria-hidden="true" />
              </Link>
              <a
                href="#how"
                className="flex min-h-[52px] items-center rounded-tile bg-surface px-[22px] text-base font-bold text-ink no-underline"
              >
                {t("nav.how")}
              </a>
            </div>
            <ul
              aria-label={t("hero.promisesLabel")}
              className="m-0 flex list-none flex-wrap gap-x-5 gap-y-2 p-0 text-sm font-semibold text-ink-body"
            >
              {(["withdraw", "seed", "revoke"] as const).map((k) => (
                <li key={k} className="flex items-center gap-2">
                  <Check size={18} strokeWidth={2.2} className="text-fits" aria-hidden="true" />
                  {t(`hero.promises.${k}`)}
                </li>
              ))}
            </ul>
          </div>
          <AgentIllustration />
        </section>

        <section
          id="how"
          className={`${SECTION} flex flex-col gap-8 rounded-[32px] border border-border bg-surface px-[clamp(20px,4vw,48px)] py-[clamp(32px,5vw,56px)]`}
        >
          <div className="flex max-w-[640px] flex-col gap-2.5">
            <span className={`${EYEBROW} text-accent`}>{t("how.eyebrow")}</span>
            <h2 className={H2}>{t("how.title")}</h2>
          </div>
          <ol className="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-4 p-0">
            {steps.map((k, i) => (
              <li key={k} className="flex flex-col gap-3 rounded-[22px] bg-surface-2 p-6">
                <span
                  aria-hidden="true"
                  className="flex size-10 items-center justify-center rounded-full bg-accent font-extrabold text-surface"
                >
                  {i + 1}
                </span>
                <h3 className="m-0 text-lg font-extrabold">{t(`how.steps.${k}.title`)}</h3>
                <p className="m-0 text-sm leading-relaxed text-ink-2">{t(`how.steps.${k}.body`)}</p>
              </li>
            ))}
          </ol>
        </section>

        <section
          id="strategies"
          className={`${SECTION} flex flex-col gap-6 px-[clamp(4px,2vw,24px)] py-[clamp(24px,4vw,40px)]`}
        >
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="flex max-w-[640px] flex-col gap-2.5">
              <span className={`${EYEBROW} text-accent`}>{t("strategies.eyebrow")}</span>
              <h2 className={H2}>{t("strategies.title")}</h2>
              <p className="m-0 text-[15px] leading-relaxed text-ink-2">{t("strategies.body")}</p>
            </div>
          </div>
          <StrategyGrid />
          <p className="m-0 text-[13px] text-ink-2">{t("strategies.backtest")}</p>
        </section>

        <section
          id="safety"
          className={`${SECTION} flex flex-wrap gap-10 rounded-[32px] bg-ink px-[clamp(20px,4vw,48px)] py-[clamp(32px,5vw,56px)] text-surface`}
        >
          <div className="flex min-w-0 flex-[1_1_360px] flex-col gap-3.5">
            <span className={`${EYEBROW} text-on-ink-accent`}>{t("safety.eyebrow")}</span>
            <h2 className={H2}>{t("safety.title")}</h2>
            <p className="m-0 text-[15px] leading-relaxed text-on-ink-2">{t("safety.body")}</p>
            <ul className="m-0 mt-2 flex list-none flex-col gap-2.5 p-0">
              <PermissionRow ok label={t("safety.read")} sub={t("safety.readSub")} />
              <PermissionRow ok label={t("safety.trade")} sub={t("safety.tradeSub")} />
              <PermissionRow
                ok={false}
                label={t("safety.withdraw")}
                sub={t("safety.withdrawSub")}
              />
            </ul>
          </div>
          <ul className="m-0 grid min-w-0 flex-[1_1_360px] list-none grid-cols-[repeat(auto-fit,minmax(220px,1fr))] content-start gap-3.5 p-0">
            <SafetyCard
              icon={<Lock size={24} />}
              title={t("safety.seedTitle")}
              body={t("safety.seedBody")}
            />
            <SafetyCard
              icon={<ShieldCheck size={24} />}
              title={t("safety.limitsTitle")}
              body={t("safety.limitsBody")}
            />
            <SafetyCard
              icon={<CircleX size={24} />}
              title={t("safety.haltTitle")}
              body={t("safety.haltBody")}
            />
            <SafetyCard
              icon={<RefreshCw size={24} />}
              title={t("safety.retryTitle")}
              body={t("safety.retryBody")}
            />
          </ul>
        </section>

        <section id="fees" className={`${SECTION} flex flex-wrap gap-5`}>
          <div className="box-border flex min-w-0 flex-[1_1_420px] flex-col gap-4 rounded-[32px] border border-border bg-surface p-[clamp(28px,4vw,48px)]">
            <span className={`${EYEBROW} text-accent`}>{t("fees.eyebrow")}</span>
            <h2 className="m-0 text-[clamp(26px,3vw,36px)] leading-[1.15] font-extrabold">
              {t("fees.title")}
            </h2>
            <p className="m-0 flex items-baseline gap-2.5">
              <span className="text-[56px] font-extrabold tracking-[-0.02em] text-accent">
                {pct}
              </span>
              <span className="text-[15px] font-bold text-ink-2">{t("fees.label")}</span>
            </p>
            <p className="m-0 text-[15px] leading-relaxed text-ink-2">{t("fees.body")}</p>
            <p className="m-0 text-sm leading-relaxed text-ink-2">{t("fees.revoke")}</p>
          </div>
          <div className="box-border flex min-w-0 flex-[1_1_420px] flex-col gap-4 rounded-[32px] border border-border bg-surface p-[clamp(28px,4vw,48px)]">
            <span className={`${EYEBROW} text-neg-ink`}>{t("fees.liveEyebrow")}</span>
            <h2 className="m-0 text-[clamp(26px,3vw,36px)] leading-[1.15] font-extrabold">
              {t("fees.liveTitle")}
            </h2>
            <p className="m-0 text-[15px] leading-relaxed text-ink-2">{t("fees.liveBody")}</p>
            <div className="flex flex-wrap gap-2.5">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-neg-bg px-3.5 py-2 text-[13px] font-extrabold text-neg-deep">
                <span aria-hidden="true" className="size-[7px] rounded-full bg-neg" />
                {t("fees.liveChip")}
              </span>
              <span className="inline-flex items-center rounded-full bg-cat-exec-bg px-3.5 py-2 text-[13px] font-bold text-muted">
                {t("fees.paperChip")}
              </span>
            </div>
          </div>
        </section>

        <section
          id="faq"
          className="mx-auto box-border flex w-full max-w-[900px] flex-col gap-5 px-1 py-[clamp(24px,4vw,40px)]"
        >
          <div className="flex flex-col items-center gap-2.5 text-center">
            <span className={`${EYEBROW} text-accent`}>{t("faq.eyebrow")}</span>
            <h2 className={H2}>{t("faq.title")}</h2>
          </div>
          <div className="flex flex-col gap-2.5">
            {faq.map((k) => (
              <details key={k} className="group rounded-tile border border-border bg-surface">
                <summary className="flex min-h-[60px] cursor-pointer list-none items-center gap-3 px-5 text-base font-bold [&::-webkit-details-marker]:hidden">
                  <span className="flex-1">{t(`faq.items.${k}.q`)}</span>
                  <ChevronDown
                    size={20}
                    className="flex-none text-ink-2 transition-transform group-open:rotate-180"
                    aria-hidden="true"
                  />
                </summary>
                <p className="m-0 px-5 pb-5 text-[15px] leading-relaxed text-ink-2">
                  {t(`faq.items.${k}.a`, { fee: pct })}
                </p>
              </details>
            ))}
          </div>
        </section>

        <section
          className={`${SECTION} relative flex flex-wrap items-center justify-between gap-6 overflow-hidden rounded-[32px] bg-accent px-[clamp(20px,4vw,48px)] py-[clamp(36px,5vw,64px)] text-surface`}
        >
          <Rings className="absolute -bottom-56 -left-40 size-[420px] opacity-25" />
          <div className="relative flex max-w-[620px] flex-col gap-2.5">
            <h2 className={H2}>{t("cta.title")}</h2>
            <p className="m-0 text-base leading-relaxed text-accent-tint">{t("cta.body")}</p>
          </div>
          <div className="relative flex flex-wrap gap-3">
            <Link
              href="/signup"
              className="flex min-h-[52px] items-center rounded-tile bg-surface px-6 text-base font-extrabold text-ink no-underline"
            >
              {t("nav.createAccount")}
            </Link>
            <Link
              href="/signin"
              className="flex min-h-[52px] items-center rounded-tile border-2 border-surface/60 px-[22px] text-base font-bold text-surface no-underline"
            >
              {t("nav.signIn")}
            </Link>
          </div>
        </section>
      </main>

      <PublicFooter />
    </div>
  );
}

export function PublicFooter() {
  const t = useTranslations("landing.footer");
  const tc = useTranslations("common");
  return (
    <footer className="mx-auto box-border flex w-full max-w-[1240px] flex-wrap items-start justify-between gap-x-8 gap-y-4 px-2 pt-4 pb-6 text-[13px] text-ink-2">
      <div className="flex min-w-0 flex-[1_1_420px] flex-col gap-2">
        <span className="font-extrabold tracking-[0.06em] text-ink">{tc("brand")}</span>
        <p className="m-0 leading-relaxed">{t("disclaimer")}</p>
      </div>
      <nav aria-label={t("legalLabel")}>
        <Link
          href="/risk-disclosure"
          className="inline-flex min-h-tap items-center font-bold text-accent no-underline"
        >
          {t("risk")}
        </Link>
      </nav>
    </footer>
  );
}

function PermissionRow({ ok, label, sub }: { ok: boolean; label: string; sub: string }) {
  return (
    <li
      className={`flex items-center gap-3 rounded-tile px-4 py-3.5 ${ok ? "bg-surface/5" : "bg-neg/15"}`}
    >
      <span
        aria-hidden="true"
        className={`font-extrabold ${ok ? "text-on-ink-pos" : "text-on-ink-neg"}`}
      >
        {ok ? "✓" : "✕"}
      </span>
      <span className="flex-1 text-sm font-bold">{label}</span>
      <span className={`text-[13px] ${ok ? "text-on-ink-2" : "text-on-ink-neg-2"}`}>{sub}</span>
    </li>
  );
}

function SafetyCard({ icon, title, body }: { icon: ReactNode; title: string; body: string }) {
  return (
    <li className="flex flex-col gap-2 rounded-[20px] bg-surface/5 p-5">
      <span aria-hidden="true" className="text-on-ink-accent">
        {icon}
      </span>
      <h3 className="m-0 text-base font-extrabold">{title}</h3>
      <p className="m-0 text-sm leading-normal text-on-ink-2">{body}</p>
    </li>
  );
}

function Rings({ className }: { className: string }) {
  return (
    <svg
      viewBox="0 0 520 520"
      fill="none"
      aria-hidden="true"
      className={`pointer-events-none ${className}`}
    >
      <circle cx="260" cy="260" r="130" className="stroke-surface" strokeWidth="1.5" />
      <circle cx="260" cy="260" r="200" className="stroke-surface" strokeWidth="1.5" />
      <circle cx="260" cy="260" r="258" className="stroke-surface" strokeWidth="1.5" />
    </svg>
  );
}

/** Thẻ Trading Agent minh hoạ: không có số tiền, chỉ trạng thái và kiểu quyết định. */
function AgentIllustration() {
  const t = useTranslations("landing.hero");
  return (
    <figure className="relative m-0 flex min-w-0 max-w-[480px] flex-[1_1_380px] flex-col gap-3.5">
      <div
        role="img"
        aria-label={t("cardLabel")}
        className="flex flex-col gap-[18px] rounded-card bg-surface p-[22px] shadow-[0_20px_48px_rgb(20_26_51/0.12)]"
      >
        <div className="flex items-center gap-3">
          <span className="flex size-11 items-center justify-center rounded-tile bg-accent text-surface">
            <Bot size={22} aria-hidden="true" />
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-base font-extrabold">{t("cardTitle")}</span>
            <span className="text-[13px] text-muted">{t("cardSub")}</span>
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-pos-bg px-2.5 py-1 text-xs font-extrabold text-fits">
            <span className="size-[7px] rounded-full bg-fits" />
            {t("cardStatus")}
          </span>
        </div>
        <div className="flex flex-col gap-2">
          <span className="text-xs font-bold text-muted">{t("cardRange")}</span>
          <div className="relative h-[72px] overflow-hidden rounded-tile bg-surface-2">
            {[14, 28, 42, 56].map((y) => (
              <div key={y} className="absolute inset-x-0 h-px bg-accent-tint" style={{ top: y }} />
            ))}
            <svg
              viewBox="0 0 400 72"
              preserveAspectRatio="none"
              fill="none"
              className="absolute inset-0 h-full w-full"
            >
              <path
                d="M0 46 C30 40 50 22 80 26 S130 54 160 50 S210 18 240 22 S300 52 330 44 S380 20 400 28"
                className="stroke-accent"
                strokeWidth="2.5"
                strokeLinecap="round"
              />
            </svg>
          </div>
        </div>
        <div className="flex flex-col gap-2.5">
          <span className="text-xs font-bold text-muted">{t("cardDecisions")}</span>
          <DecisionRow tag={t("tagFill")} text={t("cardFill1")} />
          <DecisionRow tag={t("tagFill")} text={t("cardFill2")} />
          <DecisionRow tag={t("tagState")} text={t("cardState")} muted />
        </div>
        <div className="flex gap-2 text-[13px] font-bold">
          <span className="flex min-h-10 flex-1 items-center justify-center rounded-control bg-cat-exec-bg">
            {t("cardPause")}
          </span>
          <span className="flex min-h-10 flex-1 items-center justify-center rounded-control bg-cat-exec-bg">
            {t("cardEdit")}
          </span>
          <span className="flex min-h-10 flex-1 items-center justify-center rounded-control bg-neg-soft text-neg-ink">
            {t("cardStop")}
          </span>
        </div>
      </div>
      <figcaption className="self-end text-xs text-ink-2">{t("cardNote")}</figcaption>
    </figure>
  );
}

function DecisionRow({ tag, text, muted = false }: { tag: string; text: string; muted?: boolean }) {
  return (
    <div className="flex items-center gap-2.5 text-[13px]">
      <span
        className={`rounded-lg px-2 py-0.5 text-[11px] font-extrabold ${muted ? "bg-cat-exec-bg text-ink-2" : "bg-accent-tint text-accent-ink"}`}
      >
        {tag}
      </span>
      <span className="flex-1">{text}</span>
    </div>
  );
}
