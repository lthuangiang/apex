"use client";

import { MCP_DRAFT_CONFIG, MCP_RATE_LIMITS } from "@drift/shared";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { formatInteger } from "@/lib/format";

import { LandingNav } from "./landing/landing-nav";
import { LandingShell, type LandingTheme } from "./landing-theme";

// Trang công khai "Connect DeskLabs to Claude" (MCP M6, W7), UI mới người dùng duyệt 2026-11-16
// (docs/mockups/landing-mcp/McpPage + McpPageDark, COPY.md mục MCP; DEC trong PR #166): mặc định sáng, nút đổi theme,
// font của landing. Câu chữ giữ nguyên `claudeGuide.*`. Địa chỉ server lấy từ cấu hình (`MCP_PUBLIC_URL` + `/mcp`), số
// giới hạn từ hằng số thật (`MCP_RATE_LIMITS`, `MCP_DRAFT_CONFIG`). Chữ trong ngoặc vuông ([N], [Bot name], [App name],
// [time]) là chỗ trống minh hoạ của artboard, giữ nguyên, không điền số giả (quy tắc 1.8).

const WRAP = "mx-auto box-border w-full max-w-[1240px] px-4 md:px-8";
const H2 =
  "m-0 font-display text-[32px] leading-[1.05] font-bold tracking-[-0.015em] md:text-[40px]";
const BTN_PRIMARY =
  "inline-flex min-h-[52px] items-center rounded-lg bg-l-primary px-6 text-base font-semibold text-l-on-primary no-underline hover:opacity-90";
const BTN_GHOST =
  "inline-flex min-h-[52px] items-center rounded-lg border border-l-btn-border px-[22px] text-base font-semibold text-l-text no-underline hover:opacity-85";

const WHAT = ["read", "explain", "traders", "draft"] as const;
const TABS = ["web", "code"] as const;
type Tab = (typeof TABS)[number];
const STEPS = ["s1", "s2", "s3", "s4"] as const;
const PROMPTS = ["p1", "p2", "p3", "p4", "p5", "p6"] as const;
const FAQ = ["safe", "paper", "again", "stop", "advice", "other"] as const;

export function ClaudeGuidePage({
  serverUrl,
  signedIn,
  initialTheme = null,
}: {
  /** `MCP_PUBLIC_URL` + `/mcp`, đọc ở server lúc chạy. */
  serverUrl: string;
  signedIn: boolean;
  /** Theme đã chọn (cookie, đọc ở server) để không chớp sáng khi người dùng chọn tối. */
  initialTheme?: LandingTheme | null;
}) {
  const t = useTranslations("claudeGuide");
  const launchHref = signedIn ? "/" : "/signin";
  const hours = Math.round(MCP_DRAFT_CONFIG.ttlMs / 3_600_000);
  const links = (["what", "connect", "permissions", "drafts", "faq"] as const).map((k) => ({
    href: `#${k}`,
    label: t(`nav.${k}`),
  }));
  return (
    <LandingShell initialTheme={initialTheme}>
      <LandingNav
        links={links}
        home="/"
        label={t("navLabel")}
        cta={{ href: launchHref, label: t("launch") }}
      />
      <main>
        <Hero serverUrl={serverUrl} />

        <section id="what" aria-labelledby="h-what" className="border-t border-l-line">
          <div className={`${WRAP} flex flex-col gap-8 py-16 md:py-20`}>
            <div className="flex flex-wrap items-end gap-x-16 gap-y-4">
              <h2 id="h-what" className={`${H2} min-w-0 flex-[1_1_480px]`}>
                {t("what.title")}
              </h2>
              <p className="m-0 min-w-0 flex-[1_1_360px] text-base leading-relaxed text-l-text-2">
                {t("what.body")}
              </p>
            </div>
            <dl className="m-0 grid grid-cols-[repeat(auto-fit,minmax(min(100%,260px),1fr))] gap-px border border-l-line bg-l-line">
              {WHAT.map((k, i) => (
                <div key={k} className="flex flex-col gap-2.5 bg-l-surface p-6">
                  <dt className="flex items-baseline gap-2.5">
                    <span className="font-num text-[13px] text-l-muted">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <strong className="font-display text-lg">{t(`what.items.${k}.title`)}</strong>
                  </dt>
                  <dd className="m-0 text-[14.5px] leading-normal text-l-text-2">
                    {t(`what.items.${k}.body`)}
                  </dd>
                </div>
              ))}
            </dl>
            <div className="flex flex-col gap-2 rounded-[10px] border border-l-line bg-l-never-bg px-6 py-5">
              <h3 className="m-0 text-base">{t("what.cantTitle")}</h3>
              <p className="m-0 text-[14.5px] leading-relaxed">{t("what.cant")}</p>
            </div>
          </div>
        </section>

        <Connect serverUrl={serverUrl} />

        <section id="permissions" aria-labelledby="h-perm" className="border-t border-l-line">
          <div className={`${WRAP} flex flex-wrap gap-x-16 gap-y-8 py-16 md:py-20`}>
            <div className="flex min-w-0 flex-[1_1_360px] flex-col gap-3">
              <h2 id="h-perm" className={H2}>
                {t("permissions.title")}
              </h2>
              <p className="m-0 text-base leading-relaxed text-l-text-2">{t("permissions.body")}</p>
              <p className="m-0 mt-2 text-sm text-l-muted">{t("permissions.sodex")}</p>
            </div>
            <table className="min-w-0 flex-[2_1_560px] self-start border-collapse border border-l-line text-[14.5px]">
              <tbody>
                {(["read", "draft"] as const).map((k) => (
                  <tr key={k} className="border-b border-l-line bg-l-surface align-top">
                    <th scope="row" className="px-4 py-[18px] text-left md:px-5">
                      <strong className="block text-[15.5px]">{t(`permissions.${k}Title`)}</strong>
                      <span className="font-normal text-l-text-2">{t(`permissions.${k}Body`)}</span>
                    </th>
                    <td className="px-4 py-[18px] text-right font-num text-[12.5px] text-l-text-2 md:px-5 md:whitespace-nowrap">
                      {t(`permissions.${k}When`)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section aria-labelledby="h-try" className="border-t border-l-line bg-l-band">
          <div className={`${WRAP} flex flex-col gap-[18px] py-14`}>
            <h2 id="h-try" className="m-0 font-display text-2xl font-bold">
              {t("try.title")}
            </h2>
            <ul className="m-0 flex list-none flex-wrap gap-2.5 p-0">
              {PROMPTS.map((k) => (
                <li
                  key={k}
                  className="rounded-lg border border-l-line bg-l-surface px-3.5 py-2.5 text-[14.5px]"
                >
                  {t(`try.prompts.${k}`)}
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section id="drafts" aria-labelledby="h-drafts" className="border-t border-l-line">
          <div className={`${WRAP} flex flex-col gap-8 py-16 md:py-20`}>
            <div className="flex flex-col gap-3">
              <h2 id="h-drafts" className={H2}>
                {t("drafts.title")}
              </h2>
              <p className="m-0 text-base text-l-text-2">{t("drafts.body")}</p>
            </div>
            <ol className="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(min(100%,260px),1fr))] gap-y-4 p-0">
              {(["s1", "s2", "s3"] as const).map((k, i) => (
                <li
                  key={k}
                  className={`flex flex-col gap-2.5 border-t-2 pt-[22px] pr-7 pb-2 ${
                    i === 0 ? "border-l-primary" : "border-l-line"
                  }`}
                >
                  <span className="font-num text-[13px] text-l-muted">
                    {t("drafts.step", { n: i + 1 })}
                  </span>
                  <h3 className="m-0 font-display text-xl">{t(`drafts.${k}.title`)}</h3>
                  <p className="m-0 text-[14.5px] leading-relaxed text-l-text-2">
                    {t(`drafts.${k}.body`, { hours })}
                  </p>
                </li>
              ))}
            </ol>
            <div className="flex max-w-[720px] flex-col gap-1.5 rounded-[10px] border border-l-line bg-l-surface-2 px-5 py-[18px]">
              <strong className="text-[15px]">{t("drafts.banner")}</strong>
              <span className="text-sm text-l-text-2">{t("drafts.bannerBody")}</span>
              <span className="font-num text-[12.5px] text-l-muted">
                {t("drafts.bannerExpires")}
              </span>
            </div>
          </div>
        </section>

        <section aria-label={t("disconnectLimitsLabel")} className="border-t border-l-line">
          <div className={`${WRAP} grid grid-cols-1 gap-10 py-16 lg:grid-cols-2`}>
            <div className="flex min-w-0 flex-col gap-3.5">
              <h2 className="m-0 font-display text-[26px] font-bold">{t("disconnect.title")}</h2>
              <p className="m-0 text-[15px] leading-relaxed text-l-text-2">
                {t("disconnect.body")}
              </p>
              {/* Minh hoạ màn Connected apps, không bấm được. */}
              <div className="flex flex-wrap items-center gap-3 rounded-[10px] border border-l-line bg-l-surface px-4 py-3.5">
                <span className="flex min-w-0 flex-col gap-0.5">
                  <strong className="text-[15px]">{t("disconnect.app")}</strong>
                  <span className="font-num text-xs text-l-muted">{t("disconnect.meta")}</span>
                </span>
                <span className="ml-auto inline-flex min-h-10 items-center rounded-lg border border-l-btn-border px-3.5 text-sm font-semibold text-l-never">
                  {t("disconnect.revoke")}
                </span>
              </div>
            </div>
            <div className="flex min-w-0 flex-col gap-3.5">
              <h2 className="m-0 font-display text-[26px] font-bold">{t("limits.title")}</h2>
              <dl className="m-0 grid grid-cols-2 gap-px border border-l-line bg-l-line">
                {(
                  [
                    ["perMinute", formatInteger(MCP_RATE_LIMITS.perTokenPerMinute)],
                    ["perDay", formatInteger(MCP_RATE_LIMITS.perUserPerDay)],
                    ["draftLasts", t("limits.draftLastsValue", { hours })],
                    ["openDrafts", formatInteger(MCP_DRAFT_CONFIG.maxOpen)],
                  ] as const
                ).map(([k, v]) => (
                  <div key={k} className="flex flex-col gap-1 bg-l-surface p-4">
                    <dt className="text-[13px] text-l-muted">{t(`limits.${k}`)}</dt>
                    <dd className="m-0 font-num text-[22px] font-medium">{v}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>
        </section>

        <Faq />

        <section aria-labelledby="h-ready" className="border-t border-l-line bg-l-band">
          <div className={`${WRAP} flex flex-wrap items-center gap-x-12 gap-y-5 py-14`}>
            <div className="flex min-w-0 flex-[1_1_480px] flex-col gap-2">
              <h2 id="h-ready" className="m-0 font-display text-[28px] font-bold md:text-[32px]">
                {t("ready.title")}
              </h2>
              <p className="m-0 text-base text-l-text-2">{t("ready.body")}</p>
            </div>
            <Link href={launchHref} className={BTN_PRIMARY}>
              {t("launch")}
            </Link>
          </div>
        </section>
      </main>
      <footer className="border-t border-l-line">
        <p className={`${WRAP} m-0 pt-7 pb-11 text-[13px] leading-relaxed text-l-muted`}>
          {t("footer")}
        </p>
      </footer>
    </LandingShell>
  );
}

function Hero({ serverUrl }: { serverUrl: string }) {
  const t = useTranslations("claudeGuide");
  const [copied, setCopied] = useState(false);
  const inputId = useId();
  return (
    <section
      aria-labelledby="hero-title"
      className={`${WRAP} flex flex-wrap items-start gap-x-14 gap-y-12 pt-8 pb-16 md:pt-12 md:pb-20`}
    >
      <div className="flex min-w-0 flex-[1_1_500px] flex-col gap-[22px]">
        <p className="m-0 font-num text-[12.5px] text-l-muted">{t("hero.eyebrow")}</p>
        <h1
          id="hero-title"
          className="m-0 font-display text-[40px] leading-[1.04] font-bold tracking-[-0.02em] md:text-[58px] md:leading-[1.02]"
        >
          {t("hero.title")}
        </h1>
        <p className="m-0 max-w-[540px] text-base leading-relaxed text-l-text-2 md:text-lg">
          {t("hero.body")}
        </p>
        <div className="flex max-w-[540px] flex-col gap-1.5">
          <label htmlFor={inputId} className="text-[12.5px] text-l-muted">
            {t("hero.server")}
          </label>
          <div className="flex gap-2">
            <input
              id={inputId}
              type="text"
              readOnly
              value={serverUrl}
              onFocus={(e) => {
                e.currentTarget.select();
              }}
              className="box-border min-h-12 min-w-0 flex-1 rounded-lg border border-l-btn-border bg-l-surface px-3.5 font-num text-sm text-l-text"
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
              className="min-h-12 min-w-[88px] cursor-pointer rounded-lg border border-l-btn-border bg-transparent px-4 text-sm font-semibold text-l-text"
            >
              {copied ? t("hero.copied") : t("hero.copy")}
            </button>
          </div>
          {/* Trình đọc màn hình nghe "Copied" khi đã chép xong. */}
          <span aria-live="polite" className="sr-only">
            {copied ? t("hero.copied") : ""}
          </span>
        </div>
        <div className="flex flex-wrap gap-3">
          <a href="#connect" className={BTN_PRIMARY}>
            {t("hero.connect")}
          </a>
          <a href="#what" className={BTN_GHOST}>
            {t("hero.see")}
          </a>
        </div>
        <p className="m-0 box-border max-w-[540px] rounded-lg bg-l-never-bg px-3.5 py-3 text-sm">
          {t("hero.safe")}
        </p>
      </div>

      <figure
        aria-label={t("chat.label")}
        className="m-0 min-w-0 flex-[1_1_460px] overflow-hidden rounded-xl border border-l-line bg-l-surface"
      >
        <div className="border-b border-l-line px-4 py-2.5 font-num text-[11.5px] text-l-muted">
          {t("chat.label")}
        </div>
        <div className="flex flex-col gap-3.5 p-5">
          <p className="m-0 max-w-[80%] self-end rounded-[12px_12px_4px_12px] bg-l-primary px-3.5 py-2.5 text-[14.5px] text-l-on-primary">
            {t("chat.question")}
          </p>
          <span className="self-start rounded-md border border-l-line px-2.5 py-1 font-num text-[11.5px] text-l-text-2">
            {t("chat.tools")}
          </span>
          <p className="m-0 text-[14.5px] leading-normal">{t("chat.answer")}</p>
          <p className="m-0 font-num text-[13px] leading-[1.7] text-l-text-2">
            {t("chat.line")}
            <br />
            {t("chat.line")}
          </p>
          <p className="m-0 text-[12.5px] text-l-muted">{t("chat.note")}</p>
        </div>
      </figure>
    </section>
  );
}

function Connect({ serverUrl }: { serverUrl: string }) {
  const t = useTranslations("claudeGuide.connect");
  const [tab, setTab] = useState<Tab>("web");
  const base = useId();
  const refs = useRef<Record<Tab, HTMLButtonElement | null>>({ web: null, code: null });
  // Phím mũi tên / Home / End chuyển tab và đưa focus theo (WAI-ARIA tabs, kích hoạt tự động).
  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = TABS.indexOf(tab);
    const next =
      e.key === "ArrowRight"
        ? TABS[(i + 1) % TABS.length]
        : e.key === "ArrowLeft"
          ? TABS[(i - 1 + TABS.length) % TABS.length]
          : e.key === "Home"
            ? TABS[0]
            : e.key === "End"
              ? TABS[TABS.length - 1]
              : undefined;
    if (next === undefined) return;
    e.preventDefault();
    setTab(next);
    refs.current[next]?.focus();
  };
  const command = `claude mcp add --transport http --scope user desklabs ${serverUrl}`;
  return (
    <section id="connect" aria-labelledby="h-connect" className="border-t border-l-line bg-l-band">
      <div className={`${WRAP} flex flex-wrap gap-x-14 gap-y-10 py-16 md:py-20`}>
        <div className="flex min-w-0 flex-[999_1_560px] flex-col gap-6">
          <div className="flex flex-col gap-3">
            <h2 id="h-connect" className={H2}>
              {t("title")}
            </h2>
            <p className="m-0 text-base text-l-text-2">{t("body")}</p>
          </div>
          <div
            role="tablist"
            aria-label={t("tabsLabel")}
            className="flex flex-wrap border-b border-l-line"
          >
            {TABS.map((k) => (
              <button
                key={k}
                ref={(el) => {
                  refs.current[k] = el;
                }}
                type="button"
                role="tab"
                id={`${base}-tab-${k}`}
                aria-selected={tab === k}
                aria-controls={`${base}-panel`}
                tabIndex={tab === k ? 0 : -1}
                onClick={() => {
                  setTab(k);
                }}
                onKeyDown={onKey}
                className={`-mb-px min-h-12 cursor-pointer border-0 border-b-2 border-solid bg-transparent px-[18px] text-left text-[14.5px] font-semibold ${
                  tab === k ? "border-l-primary text-l-text" : "border-transparent text-l-text-2"
                }`}
              >
                {t(`tabs.${k}`)}
              </button>
            ))}
          </div>
          <div
            role="tabpanel"
            id={`${base}-panel`}
            aria-labelledby={`${base}-tab-${tab}`}
            className="flex flex-col gap-6"
          >
            <ol className="m-0 flex list-none flex-col p-0">
              {STEPS.map((s, i) => (
                <li
                  key={s}
                  className="grid grid-cols-[40px_minmax(0,1fr)] gap-3 border-b border-l-line py-4 md:grid-cols-[48px_minmax(0,1fr)]"
                >
                  <span aria-hidden="true" className="font-num text-2xl leading-none text-l-accent">
                    {i + 1}
                  </span>
                  <span className="flex flex-col gap-1">
                    <strong className="text-base">{t(`${tab}.${s}.title`)}</strong>
                    <span className="text-[14.5px] leading-normal break-words text-l-text-2">
                      {t(`${tab}.${s}.body`, { url: serverUrl })}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
            {tab === "code" ? (
              <figure className="m-0 overflow-hidden rounded-[10px] border border-l-term-line bg-l-term-bg text-l-term-text">
                <figcaption className="border-b border-l-term-line px-3.5 py-2 font-num text-[11.5px] text-l-term-muted">
                  {t("terminal")}
                </figcaption>
                <pre className="m-0 p-3.5 font-num text-[13px] break-all whitespace-pre-wrap">
                  {command}
                </pre>
              </figure>
            ) : null}
          </div>
          <div className="flex flex-col gap-1.5 text-sm text-l-text-2">
            <strong className="text-l-text">{t("goodTitle")}</strong>
            <span>{t("good1")}</span>
            <span>{t("good2")}</span>
          </div>
        </div>
        <figure
          aria-label={t("consentLabel")}
          className="m-0 flex min-w-0 flex-[1_1_360px] flex-col gap-2.5"
        >
          <figcaption className="font-num text-xs text-l-muted">{t("consentLabel")}</figcaption>
          <div className="flex flex-col gap-3 rounded-xl border border-l-line bg-l-surface p-[22px]">
            <strong className="font-display text-[19px] leading-tight">{t("consentTitle")}</strong>
            <span className="font-num text-[13px] text-l-text-2">{t("consentFrom")}</span>
            <p className="m-0 text-[14.5px] leading-normal text-l-text-2">{t("consentBody")}</p>
            {/* Minh hoạ màn consent, không bấm được. */}
            <div className="flex gap-2.5" aria-hidden="true">
              <Fake primary>{t("allow")}</Fake>
              <Fake>{t("deny")}</Fake>
            </div>
          </div>
          <p className="m-0 text-[13px] text-l-muted">{t("consentCheck")}</p>
        </figure>
      </div>
    </section>
  );
}

function Fake({ children, primary = false }: { children: ReactNode; primary?: boolean }) {
  return (
    <span
      className={`flex min-h-[46px] flex-1 items-center justify-center rounded-lg text-[15px] font-semibold ${
        primary ? "bg-l-primary text-l-on-primary" : "border border-l-btn-border"
      }`}
    >
      {children}
    </span>
  );
}

function Faq() {
  const t = useTranslations("claudeGuide.faq");
  const [open, setOpen] = useState<number>(0);
  const base = useId();
  return (
    <section id="faq" aria-labelledby="h-faq" className="border-t border-l-line">
      <div className={`${WRAP} flex flex-wrap gap-x-16 gap-y-8 py-16 md:py-20`}>
        <h2 id="h-faq" className={`${H2} flex-[1_1_300px]`}>
          {t("title")}
        </h2>
        <div className="min-w-0 flex-[2_1_560px] border-t border-l-line">
          {FAQ.map((k, i) => {
            const isOpen = open === i;
            return (
              <div key={k} className="border-b border-l-line">
                <h3 className="m-0">
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    aria-controls={`${base}-${k}`}
                    onClick={() => {
                      setOpen(isOpen ? -1 : i);
                    }}
                    className="flex min-h-[60px] w-full cursor-pointer items-center gap-4 border-0 bg-transparent py-4 text-left text-[16.5px] font-semibold text-l-text"
                  >
                    <span className="flex-1">{t(`items.${k}.q`)}</span>
                    <span aria-hidden="true" className="font-num text-lg text-l-muted">
                      {isOpen ? "−" : "+"}
                    </span>
                  </button>
                </h3>
                <p
                  id={`${base}-${k}`}
                  hidden={!isOpen}
                  className="m-0 pr-10 pb-5 text-[15px] leading-relaxed text-l-text-2"
                >
                  {t(`items.${k}.a`)}
                </p>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
