"use client";

import { builderFeeRateOf, Strategy } from "@drift/shared";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { feeLabels } from "@/lib/format";

// Hero của landing (docs/mockups/landing-mcp/Main, Mobile): lời giới thiệu, ba cam kết, và thẻ "Example bot" có hai tab
// Market Making / Volume Builder. Sổ lệnh MM là MINH HOẠ; vòng Volume Builder là một vòng thật trên prod, ghi "Example",
// không có PnL / CPM (DevOps duyệt). Phí lấy từ builderFeeRateOf, không viết cứng.

type Tab = "mm" | "vb";

/** Sổ lệnh minh hoạ (giá, size USDC, phía, dòng của bot). */
const BOOK: readonly (readonly [string, string, "ask" | "bid", boolean])[] = [
  ["74,603", "50,133", "ask", false],
  ["74,602", "56,996", "ask", false],
  ["74,601", "57,070", "ask", true],
  ["74,600", "39,687", "bid", true],
  ["74,599", "30,287", "bid", false],
  ["74,598", "66,168", "bid", false],
];

export function LandingHero() {
  const t = useTranslations("landing");
  return (
    <main
      id="top"
      className="mx-auto box-border flex w-full max-w-[1240px] flex-wrap items-start gap-14 px-4 pt-8 pb-6 md:px-8 md:pt-14 md:pb-16"
    >
      <section
        aria-labelledby="hero-title"
        className="flex min-w-0 flex-[1_1_500px] flex-col gap-5 md:gap-7"
      >
        <p className="m-0 flex items-center gap-2.5 font-num text-[11.5px] text-l-muted md:text-[12.5px]">
          <span aria-hidden="true" className="size-2 flex-none rounded-full bg-l-live" />
          {t("hero.status")}
        </p>
        <h1
          id="hero-title"
          className="m-0 font-display text-[40px] leading-[1.04] font-bold tracking-[-0.02em] md:text-[62px] md:leading-[1.02]"
        >
          {t("hero.title")}
        </h1>
        <p className="m-0 max-w-[520px] text-base leading-relaxed text-l-text-2 md:text-lg">
          {t("hero.body")}
        </p>
        <div className="flex flex-col gap-2.5 sm:flex-row sm:flex-wrap sm:gap-3">
          <Link
            href="/signup"
            className="inline-flex min-h-[52px] items-center justify-center gap-2 rounded-lg bg-l-primary px-6 text-base font-semibold text-l-on-primary no-underline hover:opacity-90"
          >
            {t("nav.createAccount")}
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M3 8h10M9 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.8" />
            </svg>
          </Link>
          <a
            href="#panel"
            className="inline-flex min-h-[52px] items-center justify-center rounded-lg border border-l-btn-border px-[22px] text-base font-semibold text-l-text no-underline hover:opacity-85"
          >
            {t("hero.watch")}
          </a>
        </div>
        <dl
          aria-label={t("hero.promisesLabel")}
          className="m-0 flex flex-col border-t border-l-line sm:mt-2 sm:grid sm:grid-cols-3 sm:border-b"
        >
          {(
            [
              ["withdrawLabel", "withdrawValue", true],
              ["seedLabel", "seedValue", false],
              ["connectLabel", "connectValue", false],
            ] as const
          ).map(([dt, dd, never], i) => (
            <div
              key={dt}
              className={`flex justify-between gap-1.5 border-b border-l-line py-3 sm:flex-col sm:justify-start sm:border-b-0 sm:py-4 ${i === 0 ? "sm:pr-4" : "sm:px-4"} ${i < 2 ? "sm:border-r" : ""}`}
            >
              <dt className="text-[13.5px] text-l-muted sm:text-[12.5px]">{t(`hero.${dt}`)}</dt>
              <dd
                className={`m-0 font-num text-sm font-medium sm:text-[15px] ${never ? "text-l-never" : ""}`}
              >
                {t(`hero.${dd}`)}
              </dd>
            </div>
          ))}
        </dl>
      </section>
      <ExamplePanel />
    </main>
  );
}

function ExamplePanel() {
  const t = useTranslations("landing.hero");
  const ts = useTranslations("createBot.strategies");
  const tf = useTranslations("landing.strategies");
  const [tab, setTab] = useState<Tab>("mm");
  const id = useId();
  const refs = useRef<Record<Tab, HTMLButtonElement | null>>({ mm: null, vb: null });
  const tabs: readonly { key: Tab; name: string; fee: string }[] = [
    {
      key: "mm",
      name: ts("volume_maker.name"),
      fee: tf("feeRate", { rate: feeLabels(builderFeeRateOf(Strategy.volumeMaker)).pct }),
    },
    {
      key: "vb",
      name: ts("volume_farm.name"),
      fee: tf("feeRate", { rate: feeLabels(builderFeeRateOf(Strategy.volumeFarm)).pct }),
    },
  ];
  // Phím mũi tên chuyển tab (mẫu tabs của WAI-ARIA).
  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const next: Tab = tab === "mm" ? "vb" : "mm";
    setTab(next);
    refs.current[next]?.focus();
  };
  return (
    <section
      id="panel"
      aria-label={t("panelLabel")}
      className="min-w-0 flex-[1_1_460px] overflow-hidden rounded-xl border border-l-line bg-l-surface"
    >
      <div
        role="tablist"
        aria-label={t("tabsLabel")}
        className="grid grid-cols-2 border-b border-l-line"
      >
        {tabs.map((x) => {
          const on = tab === x.key;
          return (
            <button
              key={x.key}
              ref={(el) => {
                refs.current[x.key] = el;
              }}
              type="button"
              role="tab"
              id={`${id}-${x.key}-tab`}
              aria-selected={on}
              aria-controls={`${id}-${x.key}`}
              tabIndex={on ? 0 : -1}
              onClick={() => {
                setTab(x.key);
              }}
              onKeyDown={onKey}
              className={`flex min-h-14 cursor-pointer flex-col gap-0.5 border-0 border-b-2 px-3.5 py-2.5 text-left text-[13.5px] font-semibold md:min-h-16 md:gap-[3px] md:px-5 md:py-3 md:text-[14.5px] ${on ? "border-l-primary bg-l-surface-2 text-l-text" : "border-transparent bg-transparent text-l-text-2"}`}
            >
              <span>{x.name}</span>
              <span className="font-num text-[11px] font-normal text-l-muted md:text-xs">
                {x.fee}
              </span>
            </button>
          );
        })}
      </div>
      <div role="tabpanel" id={`${id}-${tab}`} aria-labelledby={`${id}-${tab}-tab`}>
        {tab === "mm" ? <MmExample /> : <VbExample />}
      </div>
      <p className="m-0 border-t border-l-line px-3.5 py-3 text-[11.5px] text-l-muted md:px-5 md:text-xs">
        {tab === "vb" ? t("vb.note") : t("cardNote")}
      </p>
    </section>
  );
}

function MmExample() {
  const t = useTranslations("landing.hero");
  return (
    <div className="flex flex-col gap-3.5 p-3.5 md:px-5 md:py-[18px]">
      <div className="flex flex-wrap items-baseline gap-2.5">
        <strong className="font-display text-[17px]">BTC-USD</strong>
        <span className="hidden text-[13px] text-l-muted sm:inline">{t("mm.sub")}</span>
        <span className="ml-auto inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-l-live">
          <span aria-hidden="true" className="size-[7px] rounded-full bg-l-live" />
          {t("cardStatus")}
        </span>
      </div>
      <table className="w-full border-collapse font-num text-[12.5px] md:text-[13px]">
        <thead>
          <tr className="text-[11px] text-l-muted md:text-[11.5px]">
            <th scope="col" className="pb-2 text-left font-normal">
              {t("price")}
            </th>
            <th scope="col" className="pb-2 text-right font-normal">
              {t("size")}
            </th>
            <th scope="col" className="hidden pb-2 text-right font-normal sm:table-cell">
              {t("side")}
            </th>
          </tr>
        </thead>
        <tbody>
          {BOOK.map(([price, size, side, you]) => (
            <tr
              key={price}
              className={you ? "bg-l-you-bg outline outline-1 outline-l-primary" : ""}
            >
              <td className={`px-2 py-[7px] ${side === "ask" ? "text-l-ask" : "text-l-bid"}`}>
                {price}
                {you ? (
                  <span className="ml-2 rounded bg-l-primary px-1.5 py-px text-[10.5px] font-medium text-l-on-primary">
                    {t("you")}
                  </span>
                ) : null}
              </td>
              <td className="px-2 py-[7px] text-right">{size}</td>
              <td className="hidden px-2 py-[7px] text-right text-l-muted sm:table-cell">
                {t(side)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex flex-col gap-2 border-t border-l-line pt-3">
        <span className="text-xs text-l-muted">{t("decisions")}</span>
        <Decision time="14:42:07" what={t("dec1")} why={t("dec1Why")} />
        <Decision time="14:42:11" what={t("dec2")} why={t("dec2Why")} />
      </div>
      <Facts
        items={[
          [t("mm.bothTitle"), t("mm.bothBody")],
          [t("mm.fillTitle"), t("mm.fillBody")],
          [t("mm.capTitle"), t("mm.capBody")],
        ]}
      />
    </div>
  );
}

function Decision({ time, what, why }: { time: string; what: string; why: string }) {
  return (
    <div className="flex gap-3 text-[13px] md:text-[13.5px]">
      <span className="font-num text-l-muted">{time}</span>
      <span>
        <strong className="font-semibold">{what}</strong>{" "}
        <span className="text-l-text-2">· {why}</span>
      </span>
    </div>
  );
}

/** Ba ô giải thích dưới thẻ (dt / dd). Dưới 640 px xếp một cột. */
function Facts({ items }: { items: readonly (readonly [string, string])[] }) {
  return (
    <dl className="m-0 grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-l-line bg-l-line sm:grid-cols-3">
      {items.map(([dt, dd]) => (
        <div key={dt} className="flex flex-col gap-[3px] bg-l-surface px-3 py-[11px]">
          <dt className="text-[13px] font-semibold">{dt}</dt>
          <dd className="m-0 text-xs text-l-muted">{dd}</dd>
        </div>
      ))}
    </dl>
  );
}

function Chip({ children }: { children: ReactNode }) {
  return <span className="rounded bg-l-surface-2 px-2 py-[3px]">{children}</span>;
}

function VbExample() {
  const t = useTranslations("landing.hero.vb");
  const steps = [
    { time: t("seconds", { s: 0 }), what: t("s1"), why: t("s1Why") },
    { time: t("seconds", { s: 0 }), what: t("s2"), why: t("s2Why") },
    { time: "", what: t("s3"), why: t("s3Why") },
    { time: t("seconds", { s: 19 }), what: t("s4"), why: t("s4Why") },
  ];
  return (
    <div className="flex flex-col gap-3.5 p-3.5 md:px-5 md:py-[18px]">
      <div className="flex flex-wrap items-baseline gap-2.5">
        <strong className="font-display text-[17px]">ETH-USD</strong>
        <span className="hidden text-[13px] text-l-muted sm:inline">{t("sub")}</span>
        {/* 390 px (artboard Mobile): thẻ gọn "One round", không có khối tín hiệu và ba ô giải thích. */}
        <span className="text-xs text-l-muted sm:hidden">{t("round")}</span>
        <span className="ml-auto rounded border border-l-line px-2 py-0.5 font-num text-[11.5px] text-l-muted">
          {t("example")}
        </span>
      </div>
      <div className="hidden flex-col gap-2.5 rounded-lg border border-l-line px-3.5 py-3 sm:flex">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-[13px] font-semibold">{t("signalTitle")}</span>
          <span className="ml-auto font-num text-[11.5px] text-l-muted">{t("signalSource")}</span>
        </div>
        <div className="flex items-center gap-2.5 font-num text-[11.5px] text-l-muted">
          <span>{t("short")}</span>
          <div aria-hidden="true" className="relative h-2 flex-1 rounded bg-l-line">
            <div className="absolute -top-1 left-1/2 h-4 w-px bg-l-muted" />
            <div className="absolute top-0 left-1/2 h-2 w-[8.3%] rounded-r bg-l-bid" />
            <div className="absolute -top-[3px] left-[58.3%] -ml-[7px] box-border size-3.5 rounded-full border-2 border-l-surface bg-l-bid" />
          </div>
          <span>{t("long")}</span>
        </div>
        <p className="m-0 text-[13.5px]">
          <strong className="font-num font-medium">{t("score", { score: "0.583" })}</strong>{" "}
          <span className="text-l-text-2">· {t("scoreWhy")}</span>
        </p>
        <div className="flex flex-wrap gap-1.5 font-num text-[11.5px]">
          <Chip>{t("trend", { regime: "SIDEWAY" })}</Chip>
          <Chip>{t("notAgainst")}</Chip>
          <Chip>{t("spreadOk")}</Chip>
        </div>
      </div>
      <span className="hidden text-[13px] font-semibold sm:inline">{t("tradeTitle")}</span>
      <figure className="m-0 sm:hidden">
        <svg viewBox="0 0 440 150" width="100%" role="img" aria-label={t("chartAria")}>
          <line
            x1="16"
            y1="31.7"
            x2="424"
            y2="31.7"
            className="stroke-l-focus"
            strokeWidth="1.4"
            strokeDasharray="4 4"
          />
          <text x="424" y="24" textAnchor="end" className="fill-l-muted font-num" fontSize="13">
            {t("chartBeShort", { price: "1,820.3" })}
          </text>
          <line
            x1="16"
            y1="112.8"
            x2="424"
            y2="112.8"
            className="stroke-l-ask"
            strokeWidth="1.4"
            strokeDasharray="4 4"
          />
          <text x="424" y="132" textAnchor="end" className="fill-l-ask font-num" fontSize="13">
            {t("chartSlShort", { price: "1,808.5" })}
          </text>
          <polyline
            points="16,58 40,54 64,50.3 92,56 120,52 150,47 180,44 210,46 240,41 270,43 300,38 330,35.1"
            fill="none"
            className="stroke-l-text"
            strokeWidth="2.2"
          />
          <circle cx="64" cy="50.3" r="6" className="fill-l-bid" />
          <text x="64" y="76" textAnchor="middle" className="fill-l-text-2 font-num" fontSize="13">
            {t("chartInShort")}
          </text>
          <circle cx="330" cy="35.1" r="6" fill="none" className="stroke-l-bid" strokeWidth="2.4" />
          <text x="330" y="60" textAnchor="middle" className="fill-l-text-2 font-num" fontSize="13">
            {t("chartOutShort", { s: 19 })}
          </text>
        </svg>
      </figure>
      <figure className="m-0 hidden sm:block">
        <svg viewBox="0 0 440 150" width="100%" role="img" aria-label={t("chartAria")}>
          <line
            x1="16"
            y1="31.7"
            x2="424"
            y2="31.7"
            className="stroke-l-focus"
            strokeWidth="1.2"
            strokeDasharray="4 4"
          />
          <text x="424" y="25" textAnchor="end" className="fill-l-muted font-num" fontSize="10.5">
            {t("chartBe", { price: "1,820.3" })}
          </text>
          <line
            x1="16"
            y1="112.8"
            x2="424"
            y2="112.8"
            className="stroke-l-ask"
            strokeWidth="1.2"
            strokeDasharray="4 4"
          />
          <text x="424" y="127" textAnchor="end" className="fill-l-ask font-num" fontSize="10.5">
            {t("chartSl", { price: "1,808.5" })}
          </text>
          <polyline
            points="16,58 40,54 64,50.3 92,56 120,52 150,47 180,44 210,46 240,41 270,43 300,38 330,35.1"
            fill="none"
            className="stroke-l-text"
            strokeWidth="1.8"
          />
          <polyline
            points="330,35.1 360,37 390,41 424,39"
            fill="none"
            className="stroke-l-muted"
            strokeWidth="1.4"
            strokeDasharray="2 3"
          />
          <circle cx="64" cy="50.3" r="5" className="fill-l-bid" />
          <text
            x="64"
            y="72"
            textAnchor="middle"
            className="fill-l-text-2 font-num"
            fontSize="10.5"
          >
            {t("chartIn", { price: "1,817.6" })}
          </text>
          <circle cx="330" cy="35.1" r="5" fill="none" className="stroke-l-bid" strokeWidth="2" />
          <text
            x="330"
            y="57"
            textAnchor="middle"
            className="fill-l-text-2 font-num"
            fontSize="10.5"
          >
            {t("chartOut", { price: "1,819.8" })}
          </text>
          <text x="16" y="146" className="fill-l-muted font-num" fontSize="10">
            {t("seconds", { s: 0 })}
          </text>
          <text x="330" y="146" textAnchor="middle" className="fill-l-muted font-num" fontSize="10">
            {t("seconds", { s: 19 })}
          </text>
        </svg>
      </figure>
      <ol className="m-0 flex list-none flex-col p-0">
        {steps.map((s) => (
          <li
            key={s.what}
            className="grid grid-cols-[52px_minmax(0,1fr)] gap-3 border-b border-l-line-2 py-[9px] text-sm"
          >
            <span className="font-num text-[12.5px] text-l-muted">{s.time}</span>
            <span className="flex flex-col gap-0.5">
              <strong className="font-semibold">{s.what}</strong>
              <span className="text-[13px] text-l-text-2">{s.why}</span>
            </span>
          </li>
        ))}
      </ol>
      <div className="hidden sm:block">
        <Facts
          items={[
            [t("volTitle"), t("volBody")],
            [t("costTitle"), t("costBody")],
            [t("makerTitle"), t("makerBody")],
          ]}
        />
      </div>
    </div>
  );
}
