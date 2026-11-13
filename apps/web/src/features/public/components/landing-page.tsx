import { builderFeeRateOf, DRIFT_BUILDER_FEE_RATE, Strategy } from "@drift/shared";
import {
  ArrowRight,
  BarChart3,
  Bell,
  Check,
  ChevronDown,
  CircleX,
  Download,
  FlaskConical,
  Lock,
  ShieldCheck,
  Sparkles,
  Waves,
  Users,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { feeLabels } from "@/lib/format";

import { catalogFor, DEFAULT_CATALOG_FEATURES } from "../../bots/catalog";
import { LANDING_STRATEGIES } from "../strategies";

import { LandingStats } from "./landing-stats";
import { LiveBook } from "./live-book";
import { PublicHeader } from "./public-header";

// Landing khi chưa đăng nhập, thiết kế lại cho SoDEX Labs (DEC-148): hero kèm thẻ Market Making minh hoạ, dải số
// liệu công khai (lấy từ API, từ trước đến nay), hai strategy chủ lực, The Lab (analytics), cách chạy, an toàn, phí,
// FAQ. Tên thương hiệu lấy từ `common.brand` để đổi một chỗ. Hình minh hoạ ghi rõ là minh hoạ.

const SECTION = "mx-auto box-border w-full max-w-[1240px]";
const EYEBROW = "text-xs font-extrabold tracking-[0.08em]";
// Mọi phần dùng chung một padding ngang để mép chữ thẳng hàng từ header tới footer (DEC-148).
const H2 = "m-0 text-[clamp(28px,3.6vw,44px)] leading-[1.1] font-extrabold tracking-[-0.02em]";

export function LandingPage() {
  const t = useTranslations("landing");
  const tc = useTranslations("common");
  const ts = useTranslations("createBot.strategies");
  const brand = tc("brand");
  const maxFee = feeLabels(DRIFT_BUILDER_FEE_RATE).pct;
  const mmFee = feeLabels(builderFeeRateOf(Strategy.volumeMaker)).pct;
  const vfFee = feeLabels(builderFeeRateOf(Strategy.volumeFarm)).pct;
  const steps = ["connect", "pick", "run", "review"] as const;
  const faq = ["independent", "withdraw", "sign", "paper", "copy", "deskAi", "halt"] as const;
  // AI Desk, Copy Trading, Telegram: ba tính năng ngoài bot (README mục AI Desk / Copy Trading / Notifications).
  const deskItems: readonly (readonly ["desk" | "copy" | "alerts", LucideIcon])[] = [
    ["desk", Sparkles],
    ["copy", Users],
    ["alerts", Bell],
  ];
  const labItems: readonly (readonly [
    "analytics" | "adverse" | "review" | "export",
    LucideIcon,
  ])[] = [
    ["analytics", BarChart3],
    ["adverse", Waves],
    ["review", FlaskConical],
    ["export", Download],
  ];

  return (
    <div className="flex flex-col gap-5 bg-bg p-4 md:p-5">
      <PublicHeader withNav />

      <main className="flex flex-col gap-5">
        <section
          id="top"
          aria-labelledby="hero-title"
          className={`${SECTION} flex flex-wrap items-center gap-12 rounded-[32px] bg-surface px-[clamp(20px,4vw,56px)] py-[clamp(32px,6vw,72px)]`}
        >
          <div className="flex min-w-0 flex-[1_1_460px] flex-col gap-6">
            <span
              className={`${EYEBROW} self-start rounded-full bg-accent-tint px-3 py-1.5 text-accent-ink`}
            >
              {t("hero.eyebrow")}
            </span>
            <h1
              id="hero-title"
              className="m-0 text-[clamp(38px,5.6vw,68px)] leading-[1.02] font-extrabold tracking-[-0.03em]"
            >
              {t("hero.title")}
            </h1>
            <p className="m-0 max-w-[560px] text-lg leading-relaxed text-ink-body">
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
                href="#strategies"
                className="flex min-h-[52px] items-center rounded-tile border border-border-input bg-surface px-[22px] text-base font-bold text-ink no-underline"
              >
                {t("hero.explore")}
              </a>
            </div>
            <ul
              aria-label={t("hero.promisesLabel")}
              className="m-0 flex list-none flex-wrap gap-x-5 gap-y-2 p-0 text-sm font-semibold text-ink-body"
            >
              {(["withdraw", "seed", "revoke"] as const).map((k) => (
                <li key={k} className="flex items-center gap-2">
                  <Check size={18} strokeWidth={2.4} className="text-fits" aria-hidden="true" />
                  {t(`hero.promises.${k}`)}
                </li>
              ))}
            </ul>
          </div>
          <LiveBook />
        </section>

        {/* Cùng danh mục Strategy Lab hiện cho một tài khoản mới (không viết cứng số). */}
        <LandingStats strategies={catalogFor(DEFAULT_CATALOG_FEATURES).length} />

        <section
          id="strategies"
          aria-labelledby="strat-title"
          className={`${SECTION} flex flex-col gap-8 px-[clamp(20px,4vw,56px)] py-[clamp(32px,5vw,64px)]`}
        >
          <div className="flex max-w-[720px] flex-col gap-3">
            <span className={`${EYEBROW} text-accent`}>{t("strategies.eyebrow")}</span>
            <h2 id="strat-title" className={H2}>
              {t("strategies.title", { count: LANDING_STRATEGIES.length })}
            </h2>
            <p className="m-0 text-base leading-relaxed text-ink-2">{t("strategies.body")}</p>
          </div>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,340px),1fr))] gap-5">
            <Flagship
              name={ts("volume_maker.name")}
              fee={t("strategies.feeRate", { rate: mmFee })}
              body={t("strategies.mm.body")}
              points={[
                <>
                  {t("strategies.mm.p1")}{" "}
                  <span className="rounded-full bg-accent-tint px-2 py-0.5 text-[11px] font-extrabold text-accent-ink">
                    {t("strategies.beta")}
                  </span>
                </>,
                t("strategies.mm.p2"),
                t("strategies.mm.p3"),
              ]}
              cta={t("strategies.mm.cta")}
              tone="accent"
            />
            <Flagship
              name={ts("volume_farm.name")}
              fee={t("strategies.feeRate", { rate: vfFee })}
              body={t("strategies.vf.body")}
              points={[t("strategies.vf.p1"), t("strategies.vf.p2"), t("strategies.vf.p3")]}
              cta={t("strategies.vf.cta")}
              tone="ink"
            />
          </div>
          <div className="flex flex-col gap-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="m-0 text-lg font-extrabold">{t("strategies.more")}</h3>
              <span className="text-[13px] font-bold text-ink-2">
                {t("strategies.feeRate", { rate: maxFee })}
              </span>
            </div>
            <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(min(100%,240px),1fr))] gap-3 p-0">
              {LANDING_STRATEGIES.map(({ key }) => (
                <li
                  key={key}
                  className="flex flex-col gap-1 rounded-[18px] border border-border bg-surface px-[18px] py-4"
                >
                  <span className="flex items-center justify-between gap-2">
                    <strong className="text-[15px]">{ts(`${key}.name`)}</strong>
                    <span className="rounded-full bg-cat-exec-bg px-2 py-0.5 text-[11px] font-bold text-ink-2">
                      {ts(`${key}.engine`)}
                    </span>
                  </span>
                  <span className="text-sm leading-normal text-ink-2">{ts(`${key}.what`)}</span>
                </li>
              ))}
            </ul>
            <p className="m-0 text-[13px] text-ink-2">{t("strategies.backtest")}</p>
          </div>
        </section>

        <section
          id="desk"
          aria-labelledby="desk-title"
          className={`${SECTION} flex flex-col gap-8 px-[clamp(20px,4vw,56px)] py-[clamp(32px,5vw,64px)]`}
        >
          <div className="flex max-w-[760px] flex-col gap-3">
            <span className={`${EYEBROW} text-accent`}>{t("desk.eyebrow")}</span>
            <h2 id="desk-title" className={H2}>
              {t("desk.title")}
            </h2>
            <p className="m-0 text-[17px] leading-relaxed text-ink-2">{t("desk.body")}</p>
          </div>
          <ul className="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(min(100%,280px),1fr))] gap-4 p-0">
            {deskItems.map(([k, Icon]) => (
              <li
                key={k}
                className="flex flex-col gap-3 rounded-[22px] border border-border bg-surface p-6"
              >
                <span className="flex size-11 items-center justify-center rounded-[14px] bg-accent-tint text-accent-ink">
                  <Icon size={22} aria-hidden="true" />
                </span>
                <h3 className="m-0 text-lg font-extrabold">{t(`desk.items.${k}.title`)}</h3>
                <p className="m-0 text-[15px] leading-relaxed text-ink-2">
                  {t(`desk.items.${k}.body`)}
                </p>
                <ul className="m-0 flex list-none flex-col gap-2 p-0">
                  {(["p1", "p2", "p3"] as const).map((pt) => (
                    <li key={pt} className="flex gap-2 text-[14.5px] leading-snug text-ink">
                      <Check size={18} className="mt-px flex-none text-pos" aria-hidden="true" />
                      <span>{t(`desk.items.${k}.${pt}`)}</span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-4">
            <Link
              href="/signup"
              className="inline-flex min-h-tap items-center gap-2 rounded-control bg-accent px-5 text-[15px] font-extrabold text-white no-underline hover:bg-accent-ink"
            >
              {t("desk.cta")}
              <ArrowRight size={18} aria-hidden="true" />
            </Link>
            <p className="m-0 text-[13px] text-muted">{t("desk.note")}</p>
          </div>
        </section>

        <section
          id="lab"
          aria-labelledby="lab-title"
          className={`${SECTION} flex flex-wrap items-center gap-12 rounded-[32px] bg-ink px-[clamp(20px,4vw,56px)] py-[clamp(36px,5vw,72px)] text-surface`}
        >
          <div className="flex min-w-0 flex-[1_1_420px] flex-col gap-4">
            <span className={`${EYEBROW} text-on-ink-accent`}>{t("lab.eyebrow")}</span>
            <h2 id="lab-title" className={H2}>
              {t("lab.title")}
            </h2>
            <p className="m-0 text-base leading-relaxed text-on-ink-2">{t("lab.body")}</p>
            <ul className="m-0 mt-2 grid list-none grid-cols-[repeat(auto-fit,minmax(min(100%,220px),1fr))] gap-5 p-0">
              {labItems.map(([k, Icon]) => (
                <li key={k} className="flex flex-col gap-1.5">
                  <Icon size={20} className="text-on-ink-accent" aria-hidden="true" />
                  <strong className="text-base">{t(`lab.items.${k}.title`)}</strong>
                  <span className="text-sm leading-normal text-on-ink-2">
                    {t(`lab.items.${k}.body`)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <AdverseIllustration />
        </section>

        <section
          id="how"
          aria-labelledby="how-title"
          className={`${SECTION} flex flex-col gap-8 px-[clamp(20px,4vw,56px)] py-[clamp(32px,5vw,64px)]`}
        >
          <div className="flex max-w-[720px] flex-col gap-3">
            <span className={`${EYEBROW} text-accent`}>{t("how.eyebrow")}</span>
            <h2 id="how-title" className={H2}>
              {t("how.title")}
            </h2>
          </div>
          <ol className="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(min(100%,240px),1fr))] gap-4 p-0">
            {steps.map((k, i) => (
              <li
                key={k}
                className="flex flex-col gap-2.5 rounded-[22px] border border-border bg-surface p-6"
              >
                <span className="text-[15px] font-extrabold text-accent">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <h3 className="m-0 text-lg font-extrabold">{t(`how.steps.${k}.title`)}</h3>
                <p className="m-0 text-[15px] leading-relaxed text-ink-2">
                  {t(`how.steps.${k}.body`)}
                </p>
              </li>
            ))}
          </ol>
        </section>

        <section
          id="safety"
          aria-labelledby="safety-title"
          className={`${SECTION} flex flex-wrap gap-10 rounded-[32px] border border-border bg-surface px-[clamp(20px,4vw,56px)] py-[clamp(36px,5vw,72px)]`}
        >
          <div className="flex min-w-0 flex-[1_1_380px] flex-col gap-3.5">
            <span className={`${EYEBROW} text-accent`}>{t("safety.eyebrow")}</span>
            <h2 id="safety-title" className={H2}>
              {t("safety.title")}
            </h2>
            <p className="m-0 text-base leading-relaxed text-ink-2">{t("safety.body")}</p>
            <ul className="m-0 mt-2 flex list-none flex-col overflow-hidden rounded-tile border border-border p-0">
              <PermissionRow label={t("safety.read")} value={t("safety.yes")} ok />
              <PermissionRow label={t("safety.trade")} value={t("safety.yes")} ok />
              <PermissionRow label={t("safety.withdraw")} value={t("safety.never")} ok={false} />
            </ul>
          </div>
          <ul className="m-0 grid min-w-0 flex-[1_1_460px] list-none grid-cols-[repeat(auto-fit,minmax(min(100%,220px),1fr))] content-start gap-4 p-0">
            <SafetyCard
              icon={<Lock size={22} />}
              title={t("safety.seedTitle")}
              body={t("safety.seedBody")}
            />
            <SafetyCard
              icon={<ShieldCheck size={22} />}
              title={t("safety.stopTitle")}
              body={t("safety.stopBody")}
            />
            <SafetyCard
              icon={<BarChart3 size={22} />}
              title={t("safety.limitsTitle")}
              body={t("safety.limitsBody")}
            />
            <SafetyCard
              icon={<CircleX size={22} />}
              title={t("safety.haltTitle")}
              body={t("safety.haltBody")}
            />
          </ul>
        </section>

        <section
          id="fees"
          aria-labelledby="fees-title"
          className={`${SECTION} flex flex-wrap items-center gap-10 px-[clamp(20px,4vw,56px)] py-[clamp(32px,5vw,64px)]`}
        >
          <div className="flex min-w-0 flex-[1_1_380px] flex-col gap-3.5">
            <span className={`${EYEBROW} text-accent`}>{t("fees.eyebrow")}</span>
            <h2 id="fees-title" className={H2}>
              {t("fees.title")}
            </h2>
            <p className="m-0 text-base leading-relaxed text-ink-2">{t("fees.body")}</p>
          </div>
          <dl className="m-0 grid min-w-0 flex-[1_1_420px] grid-cols-[repeat(auto-fit,minmax(min(100%,150px),1fr))] gap-3.5">
            {(
              [
                ["mm", mmFee],
                ["vf", vfFee],
                ["other", maxFee],
              ] as const
            ).map(([k, v]) => (
              <div
                key={k}
                className="flex flex-col-reverse gap-1.5 rounded-[20px] border border-border bg-surface p-[22px]"
              >
                <dt className="text-sm text-ink-2">{t(`fees.${k}`)}</dt>
                <dd className="m-0 text-[34px] font-extrabold tracking-[-0.02em]">{v}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section
          id="faq"
          aria-labelledby="faq-title"
          className="mx-auto box-border flex w-full max-w-[900px] flex-col gap-5 px-1 py-[clamp(16px,3vw,32px)]"
        >
          <div className="flex flex-col items-center gap-2.5 text-center">
            <span className={`${EYEBROW} text-accent`}>{t("faq.eyebrow")}</span>
            <h2 id="faq-title" className={H2}>
              {t("faq.title")}
            </h2>
          </div>
          <div className="flex flex-col gap-2.5">
            {faq.map((k) => (
              <details key={k} className="group rounded-tile border border-border bg-surface">
                <summary className="flex min-h-[60px] cursor-pointer list-none items-center gap-3 px-5 text-base font-bold [&::-webkit-details-marker]:hidden">
                  <span className="flex-1">{t(`faq.items.${k}.q`, { brand })}</span>
                  <ChevronDown
                    size={20}
                    className="flex-none text-ink-2 transition-transform group-open:rotate-180"
                    aria-hidden="true"
                  />
                </summary>
                <p className="m-0 px-5 pb-5 text-[15px] leading-relaxed text-ink-2">
                  {t(`faq.items.${k}.a`, { brand, fee: maxFee })}
                </p>
              </details>
            ))}
          </div>
        </section>

        <section
          aria-labelledby="cta-title"
          className={`${SECTION} flex flex-wrap items-center justify-between gap-6 rounded-[32px] bg-accent px-[clamp(20px,4vw,56px)] py-[clamp(36px,5vw,64px)] text-surface`}
        >
          <div className="flex min-w-0 flex-[1_1_420px] flex-col gap-2.5">
            <h2 id="cta-title" className={H2}>
              {t("cta.title")}
            </h2>
            {/* Chữ trắng của khối (text-surface): accent-tint trên nền accent chưa đạt tương phản 4.5:1. */}
            <p className="m-0 text-base leading-relaxed">{t("cta.body")}</p>
          </div>
          <div className="flex flex-wrap gap-3">
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
    <footer className="mx-auto box-border flex w-full max-w-[1240px] flex-wrap items-start justify-between gap-x-8 gap-y-4 px-[clamp(20px,4vw,56px)] pt-4 pb-6 text-[13px] text-ink-2">
      <div className="flex min-w-0 flex-[1_1_420px] flex-col gap-2">
        <span className="text-[15px] font-extrabold text-ink">{tc("brand")}</span>
        <p className="m-0 leading-relaxed font-semibold text-ink-body">{t("built")}</p>
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

function Flagship({
  name,
  fee,
  body,
  points,
  cta,
  tone,
}: {
  name: string;
  fee: string;
  body: string;
  points: readonly ReactNode[];
  cta: string;
  tone: "accent" | "ink";
}) {
  return (
    <article className="flex flex-col gap-4 rounded-[24px] border border-border bg-surface p-[clamp(20px,3vw,28px)]">
      <div className="flex items-center justify-between gap-3">
        <span
          aria-hidden="true"
          className={`flex size-12 items-center justify-center rounded-tile ${tone === "accent" ? "bg-accent-tint text-accent" : "bg-ink text-surface"}`}
        >
          {tone === "accent" ? <Waves size={24} /> : <BarChart3 size={24} />}
        </span>
        <span className="text-[13px] font-bold text-ink-2">{fee}</span>
      </div>
      <h3 className="m-0 text-[26px] font-extrabold tracking-[-0.01em]">{name}</h3>
      <p className="m-0 text-base leading-relaxed text-ink-2">{body}</p>
      <ul className="m-0 flex list-none flex-col gap-2.5 p-0 text-[15px]">
        {points.map((p, i) => (
          <li key={i} className="flex gap-2.5">
            <Check
              size={18}
              strokeWidth={2.4}
              className="mt-0.5 flex-none text-fits"
              aria-hidden="true"
            />
            <span>{p}</span>
          </li>
        ))}
      </ul>
      <Link
        href="/signup"
        className="mt-auto inline-flex min-h-tap items-center gap-1.5 self-start font-bold text-accent no-underline"
      >
        {cta}
        <ArrowRight size={16} aria-hidden="true" />
      </Link>
    </article>
  );
}

function PermissionRow({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <li
      className={`flex items-center justify-between gap-3 border-b border-border px-[18px] py-3.5 text-[15px] last:border-b-0 ${ok ? "" : "bg-neg-bg"}`}
    >
      <span>{label}</span>
      <strong className={ok ? "text-fits" : "text-neg-ink"}>{value}</strong>
    </li>
  );
}

function SafetyCard({ icon, title, body }: { icon: ReactNode; title: string; body: string }) {
  return (
    <li className="flex flex-col gap-2 rounded-[20px] border border-border p-[22px]">
      <span aria-hidden="true" className="text-accent">
        {icon}
      </span>
      <h3 className="m-0 text-[17px] font-extrabold">{title}</h3>
      <p className="m-0 text-[15px] leading-normal text-ink-2">{body}</p>
    </li>
  );
}

function AdverseIllustration() {
  const t = useTranslations("landing.lab");
  // Chiều cao cột minh hoạ (%): tắt / bật Smart quoting ở 1, 3, 5 phút.
  const bars = [
    { m: 1, off: 70, on: 38 },
    { m: 3, off: 88, on: 52 },
    { m: 5, off: 60, on: 44 },
  ];
  return (
    <figure
      role="img"
      aria-label={t("chartLabel")}
      className="m-0 flex min-w-0 flex-[1_1_380px] flex-col gap-4 rounded-[24px] border border-surface/15 bg-surface/5 p-6"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <strong className="text-base">{t("chartTitle")}</strong>
        <span className="text-xs text-on-ink-2">{t("chartSub")}</span>
      </div>
      <div className="grid h-[180px] grid-cols-3 items-end gap-4 border-b border-surface/15 pb-2">
        {bars.map((b) => (
          <div key={b.m} className="flex h-full items-end justify-center gap-1.5">
            <span
              className="w-7 rounded-t-[6px] bg-bot-orange"
              style={{ height: `${String(b.off)}%` }}
            />
            <span
              className="w-7 rounded-t-[6px] bg-on-ink-accent"
              style={{ height: `${String(b.on)}%` }}
            />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-3 gap-4 text-center text-[13px] text-on-ink-2">
        {bars.map((b) => (
          <span key={b.m}>{t("after", { m: b.m })}</span>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-4 text-xs text-on-ink-2">
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-[3px] bg-bot-orange" />
          {t("off")}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-[3px] bg-on-ink-accent" />
          {t("on")}
        </span>
        <span className="ml-auto">{t("illustration")}</span>
      </div>
    </figure>
  );
}
