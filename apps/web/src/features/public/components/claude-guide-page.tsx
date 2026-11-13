"use client";

import { MCP_DRAFT_CONFIG, MCP_RATE_LIMITS } from "@drift/shared";
import {
  Ban,
  ChartLine,
  CircleAlert,
  Copy,
  MessageCircle,
  Pencil,
  Plus,
  ShieldCheck,
  Sparkles,
  Users,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useId, useRef, useState, type KeyboardEvent } from "react";

import { formatInteger } from "@/lib/format";

import { BrandMark } from "./public-header";

// Trang công khai "Connect DeskLabs to Claude" (MCP M6, W7; mockup docs/mockups/mcp-guide/Main.dc.html, câu chữ PM
// duyệt). Địa chỉ server lấy từ cấu hình (`MCP_PUBLIC_URL` + `/mcp`), số giới hạn từ hằng số thật (`MCP_RATE_LIMITS`,
// `MCP_DRAFT_CONFIG`). Chữ trong ngoặc vuông ([N], [Bot name], [App name], [time]) là chỗ trống minh hoạ của artboard,
// giữ nguyên, không điền số giả (quy tắc 1.8).

const WRAP = "mx-auto box-border w-full max-w-[1180px] px-6";
const H2 = "m-0 text-[clamp(26px,4vw,34px)] font-extrabold tracking-[-0.02em]";
const BTN =
  "inline-flex min-h-12 items-center justify-center rounded-[12px] px-[22px] text-[15px] font-bold no-underline";

const WHAT: readonly (readonly ["read" | "explain" | "traders" | "draft", LucideIcon])[] = [
  ["read", ChartLine],
  ["explain", CircleAlert],
  ["traders", Users],
  ["draft", Pencil],
];
const TABS = ["web", "code"] as const;
type Tab = (typeof TABS)[number];
const STEPS = ["s1", "s2", "s3", "s4"] as const;
const PROMPTS = ["p1", "p2", "p3", "p4", "p5", "p6"] as const;
const FAQ = ["safe", "paper", "again", "stop", "advice", "other"] as const;

export function ClaudeGuidePage({
  serverUrl,
  signedIn,
}: {
  /** `MCP_PUBLIC_URL` + `/mcp`, đọc ở server lúc chạy. */
  serverUrl: string;
  signedIn: boolean;
}) {
  const t = useTranslations("claudeGuide");
  const launchHref = signedIn ? "/" : "/signin";
  const hours = Math.round(MCP_DRAFT_CONFIG.ttlMs / 3_600_000);
  return (
    <div className="min-h-dvh bg-bg text-ink">
      <header className="border-b border-border bg-surface">
        <div className={`${WRAP} flex flex-wrap items-center gap-x-6 gap-y-2 py-3.5`}>
          <Link href="/" className="flex items-center gap-2.5 text-ink no-underline">
            <BrandMark />
            <span className="text-lg font-extrabold tracking-[-0.01em]">{t("brand")}</span>
          </Link>
          <nav
            aria-label={t("navLabel")}
            className="flex flex-auto flex-wrap gap-x-[18px] gap-y-1 text-sm font-semibold"
          >
            {(["what", "connect", "permissions", "drafts", "faq"] as const).map((k) => (
              <a
                key={k}
                href={`#${k}`}
                className="inline-flex min-h-9 items-center text-ink-body no-underline hover:text-accent"
              >
                {t(`nav.${k}`)}
              </a>
            ))}
          </nav>
          <Link
            href={launchHref}
            className="inline-flex min-h-tap items-center rounded-[12px] bg-accent px-[18px] text-sm font-bold text-white no-underline hover:bg-accent-ink"
          >
            {t("launch")}
          </Link>
        </div>
      </header>

      <main id="top">
        <Hero serverUrl={serverUrl} />

        <section
          id="what"
          aria-labelledby="what-title"
          className="border-y border-border bg-surface"
        >
          <div className={`${WRAP} flex flex-col gap-7 py-16`}>
            <div className="flex flex-col gap-2">
              <h2 id="what-title" className={H2}>
                {t("what.title")}
              </h2>
              <p className="m-0 text-base text-ink-body">{t("what.body")}</p>
            </div>
            <ul className="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(min(100%,260px),1fr))] gap-4 p-0">
              {WHAT.map(([k, Icon]) => (
                <li
                  key={k}
                  className="flex flex-col gap-2.5 rounded-[18px] border border-border bg-surface-2 p-[22px]"
                >
                  <span className="flex size-10 items-center justify-center rounded-[12px] bg-accent-tint text-accent-ink">
                    <Icon size={20} aria-hidden="true" />
                  </span>
                  <h3 className="m-0 text-lg font-extrabold">{t(`what.items.${k}.title`)}</h3>
                  <p className="m-0 text-[15px] leading-relaxed text-ink-body">
                    {t(`what.items.${k}.body`)}
                  </p>
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap items-start gap-3.5 rounded-[18px] border border-neg-border bg-neg-bg px-[22px] py-5">
              <Ban size={22} className="mt-0.5 flex-none text-neg-ink" aria-hidden="true" />
              <div className="flex min-w-0 flex-[1_1_300px] flex-col gap-1.5 text-neg-ink">
                <strong className="text-base">{t("what.cantTitle")}</strong>
                <p className="m-0 text-[15px] leading-relaxed">{t("what.cant")}</p>
              </div>
            </div>
          </div>
        </section>

        <Connect serverUrl={serverUrl} />

        <section
          id="permissions"
          aria-labelledby="permissions-title"
          className="border-y border-border bg-surface"
        >
          <div className={`${WRAP} flex flex-wrap gap-10 py-16`}>
            <div className="flex min-w-0 flex-[1_1_320px] flex-col gap-2.5">
              <h2 id="permissions-title" className={H2}>
                {t("permissions.title")}
              </h2>
              <p className="m-0 text-base leading-relaxed text-ink-body">{t("permissions.body")}</p>
            </div>
            <div className="flex min-w-0 flex-[999_1_520px] flex-col gap-3">
              {(
                [
                  ["read", "bg-accent-tint text-accent-ink"],
                  ["draft", "bg-warn-bg text-warn"],
                ] as const
              ).map(([k, chip]) => (
                <div
                  key={k}
                  className="flex flex-wrap items-start gap-4 rounded-[18px] border border-border p-5"
                >
                  <div className="flex min-w-0 flex-[1_1_260px] flex-col gap-1">
                    <strong className="text-base">{t(`permissions.${k}Title`)}</strong>
                    <span className="text-[15px] leading-relaxed text-ink-body">
                      {t(`permissions.${k}Body`)}
                    </span>
                  </div>
                  <span className={`rounded-full px-3 py-1.5 text-[13px] font-bold ${chip}`}>
                    {t(`permissions.${k}When`)}
                  </span>
                </div>
              ))}
              <p className="m-0 text-sm text-ink-2">{t("permissions.sodex")}</p>
            </div>
          </div>
        </section>

        <section aria-labelledby="try-title" className={`${WRAP} flex flex-col gap-5 py-16`}>
          <h2 id="try-title" className={H2}>
            {t("try.title")}
          </h2>
          <ul className="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(min(100%,300px),1fr))] gap-3 p-0">
            {PROMPTS.map((k) => (
              <li
                key={k}
                className="flex items-start gap-3 rounded-[16px] border border-border bg-surface px-[18px] py-4"
              >
                <MessageCircle
                  size={18}
                  className="mt-0.5 flex-none text-accent"
                  aria-hidden="true"
                />
                <span className="text-[15px] leading-normal text-ink">{t(`try.prompts.${k}`)}</span>
              </li>
            ))}
          </ul>
        </section>

        <section
          id="drafts"
          aria-labelledby="drafts-title"
          className="border-y border-border bg-surface"
        >
          <div className={`${WRAP} flex flex-col gap-7 py-16`}>
            <div className="flex flex-col gap-2">
              <h2 id="drafts-title" className={H2}>
                {t("drafts.title")}
              </h2>
              <p className="m-0 text-base text-ink-body">{t("drafts.body")}</p>
            </div>
            <ol className="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(min(100%,260px),1fr))] gap-4 p-0">
              {(["s1", "s2", "s3"] as const).map((k, i) => (
                <li
                  key={k}
                  className="flex flex-col gap-2 rounded-[18px] border border-border bg-surface-2 p-[22px]"
                >
                  <span className="text-[13px] font-extrabold text-accent-ink">
                    {t("drafts.step", { n: i + 1 })}
                  </span>
                  <strong className="text-[17px]">{t(`drafts.${k}.title`)}</strong>
                  <span className="text-[15px] leading-relaxed text-ink-body">
                    {t(`drafts.${k}.body`, { hours })}
                  </span>
                </li>
              ))}
            </ol>
            <div className="flex max-w-[720px] flex-wrap items-start gap-3.5 rounded-[18px] border border-border bg-surface p-[18px] shadow-card">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-accent px-2.5 py-1 text-xs font-extrabold text-white">
                <Sparkles size={12} aria-hidden="true" />
                {t("drafts.banner")}
              </span>
              <div className="flex min-w-0 flex-[1_1_300px] flex-col gap-1">
                <span className="text-[15px] leading-normal text-ink">
                  {t("drafts.bannerBody")}
                </span>
                <span className="text-[13px] text-ink-2">{t("drafts.bannerExpires")}</span>
              </div>
            </div>
          </div>
        </section>

        <section className={`${WRAP} flex flex-wrap gap-6 py-16`}>
          <div className="flex min-w-0 flex-[1_1_420px] flex-col gap-3.5 rounded-[24px] border border-border bg-surface p-6">
            <h2 className="m-0 text-2xl font-extrabold">{t("disconnect.title")}</h2>
            <p className="m-0 text-[15px] leading-relaxed text-ink-body">{t("disconnect.body")}</p>
            <div className="flex flex-wrap items-center gap-3 rounded-[14px] border border-border px-4 py-3.5">
              <div className="flex min-w-0 flex-[1_1_200px] flex-col gap-0.5">
                <strong className="text-[15px]">{t("disconnect.app")}</strong>
                <span className="text-[13px] text-ink-2">{t("disconnect.meta")}</span>
              </div>
              {/* Minh hoạ màn Connected apps, không bấm được. */}
              <span className="inline-flex min-h-10 items-center rounded-[10px] border border-neg-border px-3.5 text-sm font-bold text-neg-ink">
                {t("disconnect.revoke")}
              </span>
            </div>
          </div>
          <div className="flex min-w-0 flex-[1_1_420px] flex-col gap-3.5 rounded-[24px] border border-border bg-surface p-6">
            <h2 className="m-0 text-2xl font-extrabold">{t("limits.title")}</h2>
            <dl className="m-0 grid grid-cols-2 gap-3">
              {(
                [
                  ["perMinute", formatInteger(MCP_RATE_LIMITS.perTokenPerMinute)],
                  ["perDay", formatInteger(MCP_RATE_LIMITS.perUserPerDay)],
                  ["draftLasts", t("limits.draftLastsValue", { hours })],
                  ["openDrafts", formatInteger(MCP_DRAFT_CONFIG.maxOpen)],
                ] as const
              ).map(([k, v]) => (
                <div key={k} className="rounded-[14px] bg-surface-2 p-3.5">
                  <dt className="text-[13px] text-ink-2">{t(`limits.${k}`)}</dt>
                  <dd className="m-0 mt-1 text-[22px] font-extrabold tabular-nums">{v}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <Faq />

        <section id="launch" aria-labelledby="launch-title" className={`${WRAP} pt-14 pb-[72px]`}>
          <div className="flex flex-wrap items-center gap-6 rounded-[28px] bg-ink p-10">
            <div className="flex min-w-0 flex-[999_1_420px] flex-col gap-2">
              <h2 id="launch-title" className="m-0 text-[30px] font-extrabold text-surface">
                {t("ready.title")}
              </h2>
              <p className="m-0 text-base text-on-ink-2">{t("ready.body")}</p>
            </div>
            <Link href={launchHref} className={`${BTN} bg-surface font-extrabold text-ink`}>
              {t("launch")}
            </Link>
          </div>
          <p className="m-0 mt-5 text-center text-[13px] text-ink-2">{t("footer")}</p>
        </section>
      </main>
    </div>
  );
}

function Hero({ serverUrl }: { serverUrl: string }) {
  const t = useTranslations("claudeGuide");
  const [copied, setCopied] = useState(false);
  const inputId = useId();
  return (
    <section
      aria-labelledby="hero-title"
      className={`${WRAP} flex flex-wrap items-center gap-12 pt-[clamp(40px,7vw,72px)] pb-14`}
    >
      <div className="flex min-w-0 flex-[999_1_520px] flex-col gap-5">
        <span className="inline-flex items-center gap-2 self-start rounded-full bg-accent-tint px-3 py-1.5 text-[13px] font-bold text-accent-ink">
          <Sparkles size={14} aria-hidden="true" />
          {t("hero.eyebrow")}
        </span>
        <h1
          id="hero-title"
          className="m-0 text-[clamp(36px,6vw,52px)] leading-[1.08] font-extrabold tracking-[-0.025em]"
        >
          {t("hero.title")}
        </h1>
        <p className="m-0 max-w-[560px] text-lg leading-relaxed text-ink-body">{t("hero.body")}</p>
        <div className="flex max-w-[560px] flex-col gap-2">
          <label htmlFor={inputId} className="text-[13px] font-bold text-ink-body">
            {t("hero.server")}
          </label>
          <div className="flex flex-wrap gap-2">
            <input
              id={inputId}
              readOnly
              value={serverUrl}
              onFocus={(e) => {
                e.currentTarget.select();
              }}
              className="box-border min-h-12 min-w-0 flex-[1_1_280px] rounded-[12px] border border-border-input bg-surface px-3.5 font-mono text-[15px] text-ink"
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
              className="inline-flex min-h-12 items-center gap-2 rounded-[12px] border border-border-input bg-surface px-[18px] text-sm font-bold text-ink"
            >
              <Copy size={16} aria-hidden="true" />
              {copied ? t("hero.copied") : t("hero.copy")}
            </button>
          </div>
          {/* Trình đọc màn hình nghe "Copied" khi đã chép xong. */}
          <span aria-live="polite" className="sr-only">
            {copied ? t("hero.copied") : ""}
          </span>
        </div>
        <div className="flex flex-wrap gap-2.5">
          <a href="#connect" className={`${BTN} bg-accent text-white hover:bg-accent-ink`}>
            {t("hero.connect")}
          </a>
          <a href="#what" className={`${BTN} border border-border-input bg-surface text-ink`}>
            {t("hero.see")}
          </a>
        </div>
        <p className="m-0 flex items-center gap-2 text-sm font-semibold text-pos">
          <ShieldCheck size={16} aria-hidden="true" />
          {t("hero.safe")}
        </p>
      </div>

      <figure className="m-0 min-w-0 flex-[1_1_420px]">
        <div className="flex flex-col gap-3.5 rounded-[24px] border border-border bg-surface p-[22px] shadow-card">
          <figcaption className="flex items-center gap-2 text-xs font-bold tracking-[0.08em] text-ink-2 uppercase">
            <span aria-hidden="true" className="size-2 rounded-full bg-pos-dot" />
            {t("chat.label")}
          </figcaption>
          <p className="m-0 max-w-[85%] self-end rounded-[18px_18px_4px_18px] bg-accent px-3.5 py-3 text-[14.5px] leading-normal text-white">
            {t("chat.question")}
          </p>
          <span className="inline-flex items-center gap-1.5 self-start rounded-full border border-border bg-surface-2 px-2.5 py-1 text-xs font-semibold text-ink-body">
            <Plus size={12} aria-hidden="true" />
            {t("chat.tools")}
          </span>
          <div className="flex flex-col gap-2 rounded-[18px_18px_18px_4px] border border-border bg-surface-2 p-3.5 text-[14.5px] leading-relaxed text-ink">
            <p className="m-0">{t("chat.answer")}</p>
            <p className="m-0">
              {t("chat.line")}
              <br />
              {t("chat.line")}
            </p>
            <p className="m-0 text-[13px] text-ink-2">{t("chat.note")}</p>
          </div>
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
    <section
      id="connect"
      aria-labelledby="connect-title"
      className={`${WRAP} flex flex-col gap-6 py-16`}
    >
      <div className="flex flex-col gap-2">
        <h2 id="connect-title" className={H2}>
          {t("title")}
        </h2>
        <p className="m-0 text-base text-ink-body">{t("body")}</p>
      </div>
      <div role="tablist" aria-label={t("tabsLabel")} className="flex flex-wrap gap-2">
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
            className={`min-h-tap rounded-[12px] border px-[18px] text-sm font-bold ${
              tab === k
                ? "border-ink bg-ink text-surface"
                : "border-border-input bg-surface text-ink"
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
        className="flex flex-wrap gap-8 rounded-[24px] border border-border bg-surface p-[clamp(18px,3vw,28px)]"
      >
        <ol className="m-0 flex min-w-0 flex-[999_1_460px] list-none flex-col gap-[18px] p-0">
          {STEPS.map((s, i) => (
            <li key={s} className="flex items-start gap-3.5">
              <span
                aria-hidden="true"
                className="flex size-8 flex-none items-center justify-center rounded-full bg-accent-tint text-sm font-extrabold text-accent-ink"
              >
                {i + 1}
              </span>
              <div className="flex min-w-0 flex-col gap-1">
                <strong className="text-base">{t(`${tab}.${s}.title`)}</strong>
                <span className="text-[15px] leading-relaxed break-words text-ink-body">
                  {t(`${tab}.${s}.body`, { url: serverUrl })}
                </span>
              </div>
            </li>
          ))}
        </ol>
        <div className="flex min-w-0 flex-[1_1_320px] flex-col gap-3">
          {tab === "code" ? (
            <div className="flex flex-col gap-2.5 rounded-[18px] bg-ink p-[18px]">
              <span className="text-xs font-bold tracking-[0.08em] text-on-ink-2 uppercase">
                {t("terminal")}
              </span>
              <code className="font-mono text-sm leading-relaxed break-all text-surface">
                {command}
              </code>
            </div>
          ) : (
            <div className="flex flex-col gap-1.5 rounded-[18px] border border-warn-bar bg-warn-bg px-[18px] py-4 text-sm leading-relaxed text-warn">
              <strong className="text-[14.5px]">{t("goodTitle")}</strong>
              <span>{t("good1")}</span>
              <span>{t("good2")}</span>
            </div>
          )}
          <figure className="m-0 flex flex-col gap-2.5 rounded-[18px] border border-border bg-surface-2 p-[18px]">
            <figcaption className="text-xs font-bold tracking-[0.08em] text-ink-2 uppercase">
              {t("consentLabel")}
            </figcaption>
            <div className="flex flex-col gap-2.5 rounded-[14px] border border-border bg-surface p-4">
              <strong className="text-[15px]">{t("consentTitle")}</strong>
              <span className="text-[13px] text-ink-2">{t("consentFrom")}</span>
              <span className="text-sm leading-normal text-ink-body">{t("consentBody")}</span>
              {/* Minh hoạ màn consent, không bấm được. */}
              <div className="flex gap-2" aria-hidden="true">
                <span className="inline-flex min-h-10 items-center rounded-[10px] bg-accent px-4 text-sm font-bold text-white">
                  {t("allow")}
                </span>
                <span className="inline-flex min-h-10 items-center rounded-[10px] border border-border-input px-4 text-sm font-bold text-ink">
                  {t("deny")}
                </span>
              </div>
            </div>
            <span className="text-[13px] text-ink-2">{t("consentCheck")}</span>
          </figure>
        </div>
      </div>
    </section>
  );
}

function Faq() {
  const t = useTranslations("claudeGuide.faq");
  const [open, setOpen] = useState<number>(0);
  const base = useId();
  return (
    <section id="faq" aria-labelledby="faq-title" className="border-t border-border bg-surface">
      <div className="mx-auto box-border flex w-full max-w-[860px] flex-col gap-4 px-6 py-16">
        <h2 id="faq-title" className={`${H2} mb-2`}>
          {t("title")}
        </h2>
        {FAQ.map((k, i) => {
          const isOpen = open === i;
          return (
            <div key={k} className="overflow-hidden rounded-[16px] border border-border">
              <h3 className="m-0">
                <button
                  type="button"
                  aria-expanded={isOpen}
                  aria-controls={`${base}-${k}`}
                  onClick={() => {
                    setOpen(isOpen ? -1 : i);
                  }}
                  className="flex min-h-14 w-full items-center justify-between gap-3 bg-surface px-[18px] py-3.5 text-left text-base font-bold text-ink"
                >
                  <span>{t(`items.${k}.q`)}</span>
                  <span aria-hidden="true" className="text-xl text-ink-2">
                    {isOpen ? "−" : "+"}
                  </span>
                </button>
              </h3>
              <p
                id={`${base}-${k}`}
                hidden={!isOpen}
                className="m-0 px-[18px] pb-4 text-[15px] leading-relaxed text-ink-body"
              >
                {t(`items.${k}.a`)}
              </p>
            </div>
          );
        })}
      </div>
    </section>
  );
}
