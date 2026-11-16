"use client";

import { HOLD_BUCKETS } from "@drift/shared";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState, type ReactNode } from "react";

// Analytics theo chiến lược + Claude (docs/mockups/landing-mcp/Proof). Số trong hai thẻ analytics là VÍ DỤ tĩnh từ bot
// thật trên prod ngày 15/11, ghi "Example"; không có phí / $1M, CPM, PnL hay win rate (điều kiện của DevOps).

const H2 =
  "m-0 font-display text-[32px] leading-[1.05] tracking-[-0.015em] md:text-[44px]";
const SECTION = "mx-auto box-border flex w-full max-w-[1240px] flex-col px-4 md:px-8";

/** Inventory ví dụ: 48 bước, y = 55 là phẳng, 15 / 95 là ±20 USDC. */
const INVENTORY = [
  55, 55, 55, 55, 15, 55, 55, 55, 55, 55, 95, 55, 55, 55, 55, 55, 15, 55, 55, 55, 55, 55, 55, 95,
  55, 55, 55, 55, 55, 15, 55, 55, 55, 55, 55, 55, 95, 55, 55, 55, 55, 55, 55, 15, 55, 55, 55, 55,
];
const INV_POINTS = INVENTORY.map((y, i) => {
  const x0 = ((i * 240) / INVENTORY.length).toFixed(1);
  const x1 = (((i + 1) * 240) / INVENTORY.length).toFixed(1);
  return `${x0},${String(y)} ${x1},${String(y)}`;
}).join(" ");
/** Số lệnh đã đóng theo thời gian giữ (ví dụ), theo thứ tự HOLD_BUCKETS. */
const HOLD = [15, 14, 11, 17, 2, 0];

export function LandingProof({ serverUrl }: { serverUrl: string }) {
  return (
    <>
      <Analytics />
      <ClaudeBand serverUrl={serverUrl} />
    </>
  );
}

function Analytics() {
  const t = useTranslations("landing.analytics");
  const tm = useTranslations("agent.mma");
  const tv = useTranslations("agent.vd");
  const tb = useTranslations("agent.sa.bucket");
  const adverse: readonly (readonly [string, number])[] = [
    [tm("allQuotes"), 50.3],
    [tm("side.bid"), 50.9],
    [tm("side.ask"), 49.6],
  ];
  return (
    <section id="analytics" aria-labelledby="h-analytics" className="border-t border-l-line">
      <div className={`${SECTION} gap-8 pt-16 pb-14 md:pt-[88px] md:pb-[72px]`}>
        <Heading id="h-analytics" label={t("label")} title={t("title")} body={t("body")} />
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
          <Card id="h-mma" title={tm("title")} tag={t("example")}>
            <Kpis
              items={[
                [tm("volume"), "50,786.76", "USDC"],
                [tm("fillRate"), "37.8%", tm("fillSub", { f: "2,558", p: "6,759" })],
                [tm("rest"), "2.9 s", tm("restSub")],
                [tm("maker"), "100.0%", t("ofVolume")],
              ]}
            />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <figure className="m-0 flex flex-col gap-2.5">
                <Caption title={tm("adverseTitle")} sub={t("adverseSub")} />
                {adverse.map(([group, pct]) => (
                  <div
                    key={group}
                    className="grid grid-cols-[78px_minmax(0,1fr)_46px] items-center gap-2 text-[12.5px]"
                  >
                    <span className="text-l-text-2">{group}</span>
                    <span aria-hidden="true" className="relative h-2.5 rounded-[3px] bg-l-track">
                      <span
                        className={`absolute top-0 left-0 h-2.5 rounded-[3px] ${pct > 50 ? "bg-l-ask" : "bg-l-bid"}`}
                        style={{ width: `${String(pct)}%` }}
                      />
                      <span className="absolute -top-[3px] left-1/2 h-4 w-px bg-l-muted" />
                    </span>
                    <span className="text-right font-num">{pct.toFixed(1)}%</span>
                  </div>
                ))}
                <span className="text-[11.5px] text-l-muted">{t("coinFlip")}</span>
              </figure>
              <figure className="m-0 flex flex-col gap-2">
                <Caption
                  title={tm("inventoryTitle")}
                  sub={tm("inventorySub", { max: "40.00", flat: "95.4%" })}
                />
                <svg viewBox="0 0 240 110" width="100%" role="img" aria-label={t("inventoryAria")}>
                  <line x1="0" y1="15" x2="240" y2="15" className="stroke-l-line" strokeWidth="1" />
                  <line
                    x1="0"
                    y1="55"
                    x2="240"
                    y2="55"
                    className="stroke-l-muted"
                    strokeWidth="1"
                    strokeDasharray="3 3"
                  />
                  <line x1="0" y1="95" x2="240" y2="95" className="stroke-l-line" strokeWidth="1" />
                  <polyline points={INV_POINTS} fill="none" className="stroke-l-bid" strokeWidth="1.6" />
                  <text x="0" y="11" className="fill-l-muted font-num" fontSize="9">
                    +20
                  </text>
                  <text x="0" y="107" className="fill-l-muted font-num" fontSize="9">
                    −20
                  </text>
                </svg>
              </figure>
            </div>
            <Note label={t("insightLabel")} body={t("insight")} />
          </Card>
          <Card id="h-vbd" title={t("vbTitle")} tag={t("example")}>
            <Kpis
              items={[
                [tv("kpiVolume"), "17,276.23", tv("kpiVolumeSub")],
                [tv("kpiMaker"), "88.3%", tv("kpiMakerSub")],
                [tv("fillRatio"), "40%", tv("fillRatioSub", { filled: 107, placed: 268 })],
                [tv("tradesPerHour"), "1.9", tv("tradesPerHourSub")],
              ]}
            />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <figure className="m-0 flex flex-col gap-2">
                <Caption title={t("holdTitle")} sub={t("holdSub")} />
                <div aria-hidden="true" className="flex h-[92px] items-end gap-1.5 border-b border-l-line">
                  {HOLD_BUCKETS.map((b, i) => {
                    const n = HOLD[i] ?? 0;
                    return (
                      <div key={b.key} className="flex flex-1 flex-col items-center gap-[3px]">
                        <span className="font-num text-[10.5px] text-l-muted">{n}</span>
                        <span
                          className="w-full rounded-t-[3px] bg-l-bar"
                          style={{ height: `${String(Math.max(2, Math.round((n / 17) * 70)))}px` }}
                        />
                      </div>
                    );
                  })}
                </div>
                <div aria-hidden="true" className="flex gap-1.5 font-num text-[10px] text-l-muted">
                  {HOLD_BUCKETS.map((b) => (
                    <span key={b.key} className="flex-1 text-center">
                      {tb(b.key)}
                    </span>
                  ))}
                </div>
                <p className="sr-only">{t("holdAria")}</p>
              </figure>
              <figure className="m-0 flex flex-col gap-2.5">
                <Caption title={t("splitTitle")} sub={t("splitSub")} />
                <Split
                  a={t("share", { label: tv("legend.buy"), pct: "50.0%" })}
                  b={t("share", { label: tv("legend.sell"), pct: "50.0%" })}
                  pct={50}
                  tone="bg-l-bar"
                />
                <Split
                  a={t("share", { label: tv("legend.maker"), pct: "88.3%" })}
                  b={t("share", { label: tv("legend.taker"), pct: "11.7%" })}
                  pct={88.3}
                  tone="bg-l-bid"
                />
              </figure>
            </div>
            <Note label={t("reviewLabel")} body={t("reviewBody")} />
          </Card>
        </div>
        <p className="m-0 text-[13px] text-l-muted">{t("note")}</p>
      </div>
    </section>
  );
}

function ClaudeBand({ serverUrl }: { serverUrl: string }) {
  const t = useTranslations("claudeGuide");
  const tl = useTranslations("landing");
  const [copied, setCopied] = useState(false);
  return (
    <section id="claude" aria-labelledby="h-claude" className="border-t border-l-line bg-l-band">
      <div
        className={`${SECTION} gap-10 py-16 md:flex-row md:flex-wrap md:items-start md:gap-x-16 md:py-[88px]`}
      >
        <div className="flex min-w-0 flex-[1_1_420px] flex-col gap-5">
          <span className="font-num text-[13px] text-l-muted">{t("hero.eyebrow")}</span>
          <h2 id="h-claude" className={H2}>
            {t("hero.title")}
          </h2>
          <p className="m-0 text-base leading-relaxed text-l-text-2">{t("hero.body")}</p>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="mcp-url" className="text-[12.5px] text-l-muted">
              {t("hero.server")}
            </label>
            <div className="flex gap-2">
              <input
                id="mcp-url"
                type="text"
                readOnly
                value={serverUrl}
                onFocus={(e) => {
                  e.currentTarget.select();
                }}
                className="box-border min-h-11 min-w-0 flex-1 rounded-lg border border-l-line bg-l-surface px-3 font-num text-[13.5px] text-l-text"
              />
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(serverUrl).then(
                    () => {
                      setCopied(true);
                    },
                    () => undefined,
                  );
                }}
                className="min-h-11 cursor-pointer rounded-lg border border-l-btn-border bg-transparent px-4 text-sm font-semibold text-l-text"
              >
                {copied ? t("hero.copied") : t("hero.copy")}
              </button>
            </div>
            <span aria-live="polite" className="sr-only">
              {copied ? t("hero.copied") : ""}
            </span>
          </div>
          <div className="flex flex-wrap gap-3">
            <Link
              href="/claude#connect"
              className="inline-flex min-h-12 items-center rounded-lg bg-l-primary px-5 text-[15px] font-semibold text-l-on-primary no-underline hover:opacity-90"
            >
              {t("hero.connect")}
            </Link>
            <Link
              href="/claude#what"
              className="inline-flex min-h-12 items-center rounded-lg border border-l-btn-border px-[18px] text-[15px] font-semibold text-l-text no-underline hover:opacity-85"
            >
              {t("hero.see")}
            </Link>
          </div>
          <table className="w-full border-collapse border border-l-line text-sm">
            <caption className="pb-2 text-left text-[13px] text-l-muted">
              {tl("claude.tableCaption")}
            </caption>
            <tbody>
              <tr className="border-b border-l-line bg-l-surface">
                <th scope="row" className="px-3.5 py-3 text-left font-medium">
                  {t("permissions.readTitle")}
                </th>
                <td className="px-3.5 py-3 text-right text-[12.5px] text-l-text-2">
                  {t("permissions.readWhen")}
                </td>
              </tr>
              <tr className="border-b border-l-line bg-l-surface">
                <th scope="row" className="px-3.5 py-3 text-left font-medium">
                  {t("permissions.draftTitle")}
                </th>
                <td className="px-3.5 py-3 text-right text-[12.5px] text-l-text-2">
                  {t("permissions.draftWhen")}
                </td>
              </tr>
              <tr className="bg-l-never-bg">
                <th scope="row" className="px-3.5 py-3 text-left font-semibold">
                  {tl("claude.neverRow")}
                </th>
                <td className="px-3.5 py-3 text-right font-num text-l-never">
                  {tl("safety.never")}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <figure
          aria-label={t("chat.label")}
          className="m-0 min-w-0 flex-[1_1_480px] overflow-hidden rounded-xl border border-l-line bg-l-surface"
        >
          <div className="border-b border-l-line px-4 py-2.5 font-num text-[11.5px] text-l-muted">
            {t("chat.label")}
          </div>
          <div className="flex flex-col gap-3.5 p-5">
            <Bubble>{t("chat.question")}</Bubble>
            <span className="self-start rounded-md border border-l-line px-2.5 py-1 font-num text-[11.5px] text-l-text-2">
              {t("chat.tools")}
            </span>
            <div className="flex flex-col gap-2 text-[14.5px] leading-normal">
              <p className="m-0">{t("chat.answer")}</p>
              <p className="m-0 font-num text-[13px] text-l-text-2">
                {t("chat.line")}
                <br />
                {t("chat.line")}
              </p>
              <p className="m-0 text-[12.5px] text-l-muted">{t("chat.note")}</p>
            </div>
            <Bubble>{t("try.prompts.p6")}</Bubble>
            <div className="flex flex-col gap-1.5 rounded-[10px] border border-l-line bg-l-surface-2 p-3.5">
              <strong className="text-sm">{t("drafts.banner")}</strong>
              <span className="text-[13.5px] text-l-text-2">{t("drafts.bannerBody")}</span>
              <span className="font-num text-xs text-l-muted">{t("drafts.bannerExpires")}</span>
            </div>
          </div>
        </figure>
      </div>
    </section>
  );
}

function Bubble({ children }: { children: ReactNode }) {
  return (
    <p className="m-0 max-w-[80%] self-end rounded-[12px_12px_4px_12px] bg-l-primary px-3.5 py-2.5 text-[14.5px] text-l-on-primary">
      {children}
    </p>
  );
}

export function Heading({
  id,
  label,
  title,
  body,
}: {
  id: string;
  label: string;
  title: string;
  body?: string;
}) {
  return (
    <div className="flex flex-wrap items-end gap-x-16 gap-y-5">
      <div className="flex min-w-0 flex-[1_1_520px] flex-col gap-3.5">
        <span className="font-num text-[13px] text-l-muted">{label}</span>
        <h2 id={id} className={H2}>
          {title}
        </h2>
      </div>
      {body === undefined ? null : (
        <p className="m-0 min-w-0 flex-[1_1_380px] text-base leading-relaxed text-l-text-2">{body}</p>
      )}
    </div>
  );
}

function Card({
  id,
  title,
  tag,
  children,
}: {
  id: string;
  title: string;
  tag: string;
  children: ReactNode;
}) {
  return (
    <article
      aria-labelledby={id}
      className="flex min-w-0 flex-col gap-[18px] rounded-xl border border-l-line bg-l-surface p-4 md:p-5"
    >
      <header className="flex flex-wrap items-baseline gap-2.5">
        <h3 id={id} className="m-0 font-display text-xl">
          {title}
        </h3>
        <span className="ml-auto font-num text-[11.5px] text-l-muted">{tag}</span>
      </header>
      {children}
    </article>
  );
}

function Kpis({ items }: { items: readonly (readonly [string, string, string])[] }) {
  return (
    <dl className="m-0 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-l-line bg-l-line sm:grid-cols-4">
      {items.map(([label, value, sub]) => (
        <div key={label} className="flex flex-col gap-1 bg-l-surface p-3">
          <dt className="text-xs text-l-muted">{label}</dt>
          <dd className="m-0 font-num text-lg font-medium">{value}</dd>
          <dd className="m-0 text-[11.5px] text-l-muted">{sub}</dd>
        </div>
      ))}
    </dl>
  );
}

function Caption({ title, sub }: { title: string; sub: string }) {
  return (
    <figcaption className="flex flex-col gap-0.5">
      <strong className="text-sm">{title}</strong>
      <span className="text-xs text-l-muted">{sub}</span>
    </figcaption>
  );
}

function Split({ a, b, pct, tone }: { a: string; b: string; pct: number; tone: string }) {
  return (
    <div className="flex flex-col gap-[5px]">
      <div className="flex justify-between text-xs">
        <span>{a}</span>
        <span className="text-l-text-2">{b}</span>
      </div>
      <div aria-hidden="true" className="flex h-2.5 overflow-hidden rounded-[3px] bg-l-track">
        <span className={tone} style={{ width: `${String(pct)}%` }} />
      </div>
    </div>
  );
}

function Note({ label, body }: { label: string; body: string }) {
  return (
    <p className="m-0 rounded-lg bg-l-surface-2 px-3 py-2.5 text-[13px] leading-normal">
      <strong className="font-semibold">{label}</strong>
      <span className="text-l-text-2">{body}</span>
    </p>
  );
}
