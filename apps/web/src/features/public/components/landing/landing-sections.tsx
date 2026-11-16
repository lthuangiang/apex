"use client";

import { builderFeeRateOf, DRIFT_BUILDER_FEE_RATE, FEE_TIERS, Strategy } from "@drift/shared";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useId, useState, type ReactNode } from "react";

import { feeLabels } from "@/lib/format";

import { LANDING_STRATEGIES } from "../../strategies";

import { Heading } from "./landing-proof";

// Strategies · How it works · Safety · Fees · Also in the app · FAQ · CTA · footer
// (docs/mockups/landing-mcp/Sections). Phí lấy từ builderFeeRateOf / FEE_TIERS (DEC-258, DEC-266), không viết cứng.

const WRAP = "mx-auto box-border flex w-full max-w-[1240px] flex-col px-4 md:px-8";
const pct = (rate: number) => feeLabels(rate).pct;

/** "$200K", "$1M": ngưỡng volume của bậc phí. */
function usdShort(n: number): string {
  if (n >= 1e6) return `$${String(n / 1e6)}M`;
  if (n >= 1e3) return `$${String(n / 1e3)}K`;
  return `$${String(n)}`;
}

/** Các bậc phí Market Making theo volume tăng dần: [ngưỡng dưới, ngưỡng trên | null, mức phí]. */
function mmTiers(): { from: number; to: number | null; rate: number }[] {
  const base = builderFeeRateOf(Strategy.volumeMaker);
  const tiers = [...(FEE_TIERS[Strategy.volumeMaker] ?? [])].sort((a, b) => a.minVolume - b.minVolume);
  const out: { from: number; to: number | null; rate: number }[] = [];
  let from = 0;
  let rate = base;
  for (const t of tiers) {
    out.push({ from, to: t.minVolume, rate });
    from = t.minVolume;
    rate = t.rate;
  }
  out.push({ from, to: null, rate });
  return out;
}

export function LandingSections() {
  return (
    <>
      <Strategies />
      <How />
      <Safety />
      <Fees />
      <Extras />
      <Faq />
      <Cta />
      <LandingFooter />
    </>
  );
}

function Index({ n, label }: { n: number; label: string }) {
  const t = useTranslations("landing");
  return t("sectionIndex", { n: String(n).padStart(2, "0"), label });
}

function Strategies() {
  const t = useTranslations("landing");
  const ts = useTranslations("createBot.strategies");
  const tiers = mmTiers();
  const mmFee = pct(builderFeeRateOf(Strategy.volumeMaker));
  const vbFee = pct(builderFeeRateOf(Strategy.volumeFarm));
  const maxFee = pct(DRIFT_BUILDER_FEE_RATE);
  const lower = tiers.slice(1).map((x) => pct(x.rate));
  const compare = [
    ["trades", t("compare.tradesMm"), t("compare.tradesVb"), t("compare.tradesOther")],
    ["direction", t("compare.directionMm"), t("compare.directionVb"), t("compare.directionOther")],
    ["length", t("compare.lengthMm"), t("compare.lengthVb"), t("compare.lengthOther")],
    ["protect", t("compare.protectMm"), t("compare.protectVb"), t("compare.protectOther")],
    ["fee", t("compare.feeMm", { rate: mmFee }), vbFee, maxFee],
  ] as const;
  return (
    <section id="strategies" aria-labelledby="h-strategies">
      <div className={`${WRAP} gap-10 pt-16 pb-14 md:pt-24 md:pb-[72px]`}>
        <Heading
          id="h-strategies"
          label={Index({ n: 1, label: t("nav.strategies") })}
          title={t("strategies.title", { count: LANDING_STRATEGIES.length })}
          body={t("strategies.body")}
        />
        <div className="grid grid-cols-1 border-y border-l-line lg:grid-cols-2">
          <Flagship
            name={ts("volume_maker.name")}
            fee={t("strategies.feeRateLower", { rate: mmFee })}
            body={t("strategies.mm.body")}
            points={[
              <>
                {t("strategies.mm.p1")}{" "}
                <span className="font-num text-[11px] text-l-accent">{t("strategies.beta")}</span>
              </>,
              t("strategies.mm.p2"),
              t("strategies.mm.p3"),
              t("strategies.mm.p4", { tier2: lower[0] ?? "", tier3: lower[1] ?? "" }),
            ]}
            cta={t("strategies.mm.cta")}
            className="border-b border-l-line lg:border-r lg:border-b-0 lg:pr-10"
          />
          <Flagship
            name={ts("volume_farm.name")}
            fee={t("strategies.feeRate", { rate: vbFee })}
            body={t("strategies.vf.body")}
            points={[t("strategies.vf.p1"), t("strategies.vf.p2"), t("strategies.vf.p3")]}
            cta={t("strategies.vf.cta")}
            className="lg:pl-10"
          />
        </div>
        <div className="flex flex-col gap-3">
          <h3 className="m-0 font-display text-xl">{t("compare.title")}</h3>
          <div className="overflow-x-auto rounded-[10px] border border-l-line">
            <table className="w-full min-w-[760px] border-collapse text-[14.5px] leading-normal">
              <thead>
                <tr className="bg-l-surface text-left">
                  <th scope="col" className="w-[18%] px-[18px] py-3">
                    <span className="sr-only">{t("compare.question")}</span>
                  </th>
                  <th scope="col" className="px-[18px] py-3 font-semibold">
                    {ts("volume_maker.name")}
                  </th>
                  <th scope="col" className="px-[18px] py-3 font-semibold">
                    {ts("volume_farm.name")}
                  </th>
                  <th scope="col" className="px-[18px] py-3 font-semibold text-l-text-2">
                    {t("compare.otherCol")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {compare.map(([q, mm, vb, other]) => (
                  <tr key={q} className="border-t border-l-line-2 align-top">
                    <th scope="row" className="px-[18px] py-3.5 text-left text-[13px] font-medium text-l-muted">
                      {t(`compare.${q}Q`)}
                    </th>
                    <td className="px-[18px] py-3.5">{mm}</td>
                    <td className="px-[18px] py-3.5">{vb}</td>
                    <td className="px-[18px] py-3.5 text-l-text-2">{other}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-baseline gap-3">
            <h3 className="m-0 font-display text-xl">{t("strategies.more")}</h3>
            <span className="ml-auto font-num text-[13px] text-l-muted">
              {t("strategies.feeRate", { rate: maxFee })}
            </span>
          </div>
          <div className="overflow-x-auto rounded-[10px] border border-l-line">
            <table className="w-full min-w-[640px] border-collapse text-[14.5px]">
              <thead>
                <tr className="bg-l-surface text-left text-[12.5px] text-l-muted">
                  <th scope="col" className="px-[18px] py-3 font-medium">
                    {t("strategies.colStrategy")}
                  </th>
                  <th scope="col" className="px-[18px] py-3 font-medium">
                    {t("strategies.colMarket")}
                  </th>
                  <th scope="col" className="px-[18px] py-3 font-medium">
                    {t("strategies.colWhat")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {LANDING_STRATEGIES.map(({ key }) => (
                  <tr key={key} className="border-t border-l-line-2">
                    <th scope="row" className="px-[18px] py-[13px] text-left font-semibold whitespace-nowrap">
                      {ts(`${key}.name`)}
                    </th>
                    <td className="px-[18px] py-[13px] font-num text-[12.5px] whitespace-nowrap text-l-text-2">
                      {ts(`${key}.engine`)}
                    </td>
                    <td className="px-[18px] py-[13px] text-l-text-2">{ts(`${key}.what`)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="m-0 text-[13px] text-l-muted">{t("strategies.backtest")}</p>
        </div>
      </div>
    </section>
  );
}

function Flagship({
  name,
  fee,
  body,
  points,
  cta,
  className,
}: {
  name: string;
  fee: string;
  body: string;
  points: readonly ReactNode[];
  cta: string;
  className: string;
}) {
  return (
    <article className={`flex flex-col gap-[18px] py-8 ${className}`}>
      <div className="flex flex-wrap items-baseline gap-3">
        <h3 className="m-0 font-display text-[28px]">{name}</h3>
        <span className="ml-auto font-num text-[13px] text-l-accent">{fee}</span>
      </div>
      <p className="m-0 text-[15.5px] leading-relaxed text-l-text-2">{body}</p>
      <ol className="m-0 flex list-none flex-col p-0">
        {points.map((p, i) => (
          <li
            key={i}
            className="grid grid-cols-[40px_minmax(0,1fr)] border-t border-l-line-2 py-3 text-[15px] leading-normal"
          >
            <span className="font-num text-[13px] text-l-muted">{String(i + 1).padStart(2, "0")}</span>
            <span>{p}</span>
          </li>
        ))}
      </ol>
      <Link
        href="/signup"
        className="inline-flex min-h-12 items-center self-start rounded-lg bg-l-primary px-5 text-[15px] font-semibold text-l-on-primary no-underline hover:opacity-90"
      >
        {cta}
      </Link>
    </article>
  );
}

function How() {
  const t = useTranslations("landing");
  const steps = ["connect", "pick", "run", "review"] as const;
  return (
    <section id="how" aria-labelledby="h-how" className="border-t border-l-line">
      <div className={`${WRAP} gap-10 py-16 md:py-[88px]`}>
        <Heading id="h-how" label={Index({ n: 2, label: t("nav.how") })} title={t("how.title")} />
        <ol className="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(min(100%,240px),1fr))] p-0">
          {steps.map((k, i) => (
            <li
              key={k}
              className={`flex flex-col gap-3 border-t-2 pt-6 pr-7 pb-2 ${i === 0 ? "border-l-primary" : "border-l-line"}`}
            >
              <span className={`font-num text-[40px] leading-none ${i === 0 ? "text-l-accent" : "text-l-muted"}`}>
                {String(i + 1).padStart(2, "0")}
              </span>
              <h3 className="m-0 font-display text-[21px]">{t(`how.steps.${k}.title`)}</h3>
              <p className="m-0 text-[15px] leading-relaxed text-l-text-2">{t(`how.steps.${k}.body`)}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function Safety() {
  const t = useTranslations("landing");
  const facts = [
    ["seedTitle", "seedBody"],
    ["stopTitle", "stopBody"],
    ["limitsTitle", "limitsBody"],
    ["haltTitle", "haltBody"],
  ] as const;
  return (
    <section id="safety" aria-labelledby="h-safety" className="border-t border-l-line bg-l-band">
      <div className={`${WRAP} gap-12 py-16 md:flex-row md:flex-wrap md:gap-x-16 md:py-[88px]`}>
        <div className="flex min-w-0 flex-[1_1_440px] flex-col gap-5">
          <span className="font-num text-[13px] text-l-muted">{Index({ n: 3, label: t("nav.safety") })}</span>
          <h2 id="h-safety" className="m-0 font-display text-[32px] leading-[1.05] tracking-[-0.015em] md:text-[44px]">
            {t("safety.title")}
          </h2>
          <p className="m-0 text-base leading-relaxed text-l-text-2">{t("safety.body")}</p>
          <table className="w-full border-collapse border border-l-line text-[15px]">
            <caption className="pb-2.5 text-left text-[13px] text-l-muted">{t("safety.tableCaption")}</caption>
            <tbody>
              {(["read", "trade"] as const).map((k) => (
                <tr key={k} className="border-b border-l-line bg-l-surface">
                  <th scope="row" className="px-[18px] py-3.5 text-left font-medium">
                    {t(`safety.${k}`)}
                  </th>
                  <td className="px-[18px] py-3.5 text-right font-num text-l-live">{t("safety.yes")}</td>
                </tr>
              ))}
              <tr className="bg-l-never-bg">
                <th scope="row" className="px-[18px] py-3.5 text-left font-semibold">
                  {t("safety.withdraw")}
                </th>
                <td className="px-[18px] py-3.5 text-right font-num font-medium text-l-never">
                  {t("safety.never")}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <dl className="m-0 grid min-w-0 flex-[1_1_480px] grid-cols-1 gap-px self-start border border-l-line bg-l-line sm:grid-cols-2">
          {facts.map(([title, body]) => (
            <div key={title} className="flex flex-col gap-2.5 bg-l-surface p-6">
              <dt className="font-display text-lg font-bold">{t(`safety.${title}`)}</dt>
              <dd className="m-0 text-[14.5px] leading-normal text-l-text-2">{t(`safety.${body}`)}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

function Fees() {
  const t = useTranslations("landing");
  const ts = useTranslations("createBot.strategies");
  const tiers = mmTiers();
  const last = tiers.length - 1;
  const range = (x: { from: number; to: number | null }) =>
    x.from === 0
      ? t("fees.tier1", { amount: usdShort(x.to ?? 0) })
      : x.to === null
        ? t("fees.tier3", { amount: usdShort(x.from) })
        : t("fees.tier2", { from: usdShort(x.from), to: usdShort(x.to) });
  const NUM = "py-4 text-right font-num text-xl";
  return (
    <section id="fees" aria-labelledby="h-fees" className="border-t border-l-line">
      <div className={`${WRAP} gap-10 py-16 md:flex-row md:flex-wrap md:gap-x-16 md:py-[88px]`}>
        <div className="flex min-w-0 flex-[1_1_400px] flex-col gap-5">
          <span className="font-num text-[13px] text-l-muted">{Index({ n: 4, label: t("nav.fees") })}</span>
          <h2 id="h-fees" className="m-0 font-display text-[32px] leading-[1.05] tracking-[-0.015em] md:text-[44px]">
            {t("fees.title")}
          </h2>
          <p className="m-0 text-base leading-relaxed text-l-text-2">{t("fees.body")}</p>
        </div>
        <div className="min-w-0 flex-[1_1_520px] overflow-x-auto">
          <table className="w-full border-collapse text-[15px]">
            <thead>
              <tr className="border-b border-l-line text-left text-[12.5px] text-l-muted">
                <th scope="col" className="pb-3 font-medium">
                  {t("fees.colStrategy")}
                </th>
                <th scope="col" className="pb-3 font-medium">
                  {t("fees.colVolume")}
                </th>
                <th scope="col" className="pb-3 text-right font-medium">
                  {t("fees.colFee")}
                </th>
              </tr>
            </thead>
            <tbody>
              {tiers.map((x, i) => (
                <tr key={x.from} className={i === last ? "border-b border-l-line" : "border-b border-l-line-2"}>
                  {i === 0 ? (
                    <th scope="row" rowSpan={tiers.length} className="py-4 pr-4 text-left align-top font-semibold">
                      {ts("volume_maker.name")}
                    </th>
                  ) : null}
                  <td className="py-4 font-num text-[13.5px] text-l-text-2">{range(x)}</td>
                  <td className={`${NUM} ${i === last ? "text-l-accent" : ""}`}>{pct(x.rate)}</td>
                </tr>
              ))}
              <tr className="border-b border-l-line">
                <th scope="row" className="py-4 pr-4 text-left font-semibold">
                  {ts("volume_farm.name")}
                </th>
                <td className="py-4 text-[13.5px] text-l-muted">{t("fees.oneRate")}</td>
                <td className={NUM}>{pct(builderFeeRateOf(Strategy.volumeFarm))}</td>
              </tr>
              <tr>
                <th scope="row" className="py-4 pr-4 text-left font-semibold">
                  {t("fees.other")}
                </th>
                <td className="py-4 text-[13.5px] text-l-muted">{t("fees.oneRate")}</td>
                <td className={NUM}>{pct(DRIFT_BUILDER_FEE_RATE)}</td>
              </tr>
            </tbody>
          </table>
          <p className="mt-3.5 mb-0 text-[13px] text-l-muted">{t("fees.tierNote")}</p>
        </div>
      </div>
    </section>
  );
}

function Extras() {
  const t = useTranslations("landing");
  return (
    <section aria-labelledby="h-more" className="border-t border-l-line">
      <div className={`${WRAP} gap-6 py-14`}>
        <h2 id="h-more" className="m-0 font-display text-[22px]">
          {t("extras.title")}
        </h2>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,240px),1fr))] border-t border-l-line">
          {(["desk", "copy", "alerts"] as const).map((k) => (
            <div key={k} className="flex flex-col gap-2 pt-5 pr-6 pb-2">
              <h3 className="m-0 text-base font-semibold">{t(`desk.items.${k}.title`)}</h3>
              <p className="m-0 text-sm leading-normal text-l-text-2">{t(`desk.items.${k}.body`)}</p>
            </div>
          ))}
        </div>
        <p className="m-0 text-[13px] text-l-muted">{t("desk.note")}</p>
      </div>
    </section>
  );
}

/** Thứ tự câu hỏi theo artboard Sections. */
const FAQ = ["independent", "withdraw", "sign", "paper", "halt", "copy", "deskAi", "claude"] as const;

function Faq() {
  const t = useTranslations("landing");
  const brand = useTranslations("common")("brand");
  const maxFee = pct(DRIFT_BUILDER_FEE_RATE);
  // Artboard mở sẵn câu thứ hai.
  const [open, setOpen] = useState<number>(1);
  const id = useId();
  return (
    <section id="faq" aria-labelledby="h-faq" className="border-t border-l-line">
      <div className={`${WRAP} gap-8 py-16 md:flex-row md:flex-wrap md:gap-x-16 md:py-[88px]`}>
        <div className="flex min-w-0 flex-[1_1_320px] flex-col gap-3.5">
          <span className="font-num text-[13px] text-l-muted">{Index({ n: 5, label: t("nav.faq") })}</span>
          <h2 id="h-faq" className="m-0 font-display text-[32px] leading-[1.05] tracking-[-0.015em] md:text-[44px]">
            {t("faq.title")}
          </h2>
        </div>
        <div className="min-w-0 flex-[2_1_560px] border-t border-l-line">
          {FAQ.map((k, i) => {
            const isOpen = open === i;
            return (
              <div key={k} className="border-b border-l-line">
                <h3 className="m-0">
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    aria-controls={`${id}-${k}`}
                    onClick={() => {
                      setOpen(isOpen ? -1 : i);
                    }}
                    className="flex min-h-[60px] w-full cursor-pointer items-center gap-4 border-0 bg-transparent py-4 text-left text-base font-semibold text-l-text md:text-[16.5px]"
                  >
                    <span className="flex-1">{t(`faq.items.${k}.q`, { brand })}</span>
                    <span aria-hidden="true" className="font-num text-lg text-l-muted">
                      {isOpen ? "−" : "+"}
                    </span>
                  </button>
                </h3>
                {isOpen ? (
                  <p
                    id={`${id}-${k}`}
                    className="m-0 pr-10 pb-5 text-[15px] leading-[1.65] text-l-text-2"
                  >
                    {t(`faq.items.${k}.a`, { brand, fee: maxFee })}
                    {k === "claude" ? (
                      <>
                        {" "}
                        <Link href="/claude" className="font-semibold text-l-accent">
                          {t("faq.items.claude.link")}
                        </Link>
                      </>
                    ) : null}
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function Cta() {
  const t = useTranslations("landing");
  return (
    <section aria-labelledby="h-cta" className="border-t border-l-line bg-l-band">
      <div className={`${WRAP} gap-6 py-16 md:flex-row md:flex-wrap md:items-center md:gap-x-12`}>
        <div className="flex min-w-0 flex-[1_1_480px] flex-col gap-2.5">
          <h2 id="h-cta" className="m-0 font-display text-[28px] tracking-[-0.01em] md:text-4xl">
            {t("cta.title")}
          </h2>
          <p className="m-0 text-base text-l-text-2">{t("cta.body")}</p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Link
            href="/signup"
            className="inline-flex min-h-[52px] items-center rounded-lg bg-l-primary px-6 text-base font-semibold text-l-on-primary no-underline hover:opacity-90"
          >
            {t("nav.createAccount")}
          </Link>
          <Link
            href="/signin"
            className="inline-flex min-h-[52px] items-center rounded-lg border border-l-btn-border px-[22px] text-base font-semibold text-l-text no-underline hover:opacity-85"
          >
            {t("nav.signIn")}
          </Link>
        </div>
      </div>
    </section>
  );
}

export function LandingFooter() {
  const t = useTranslations("landing.footer");
  const brand = useTranslations("common")("brand");
  return (
    <footer className="border-t border-l-line">
      <div className={`${WRAP} gap-4 pt-8 pb-12 md:flex-row md:flex-wrap md:gap-x-12`}>
        <div className="flex min-w-0 flex-[1_1_520px] flex-col gap-2">
          <strong className="font-display text-[17px]">{brand}</strong>
          <span className="text-[13.5px] font-semibold">{t("built")}</span>
          <span className="text-[13px] leading-relaxed text-l-muted">{t("disclaimer")}</span>
        </div>
        <nav aria-label={t("legalLabel")} className="flex gap-5 text-sm">
          <Link href="/risk-disclosure" className="inline-flex min-h-11 items-center text-l-accent">
            {t("risk")}
          </Link>
          <Link href="/claude" className="inline-flex min-h-11 items-center text-l-accent">
            {t("claude")}
          </Link>
        </nav>
      </div>
    </footer>
  );
}
