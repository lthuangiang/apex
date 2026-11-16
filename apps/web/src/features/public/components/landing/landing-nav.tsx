"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";

import { ThemeToggle } from "../landing-theme";

// Nav của landing và trang MCP (docs/mockups/landing-mcp Main / McpPage / Mobile): logo, link anchor, nút đổi theme,
// Sign in, Launch app. Dưới 1024 px các link gom vào menu (artboard Mobile: Launch app + nút menu).

export interface NavLink {
  href: string;
  label: string;
}

export function Logo() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" aria-hidden="true" className="flex-none">
      <rect width="24" height="24" rx="5.6" className="fill-l-primary" />
      <path
        d="M6.5 5h5.2a7 7 0 0 1 0 14H6.5z"
        fill="none"
        className="stroke-l-on-primary"
        strokeWidth="2.4"
        strokeLinejoin="round"
      />
      <rect x="9.6" y="9" width="4.6" height="2" rx="1" className="fill-l-on-primary" />
      <rect
        x="9.6"
        y="13"
        width="3.2"
        height="2"
        rx="1"
        className="fill-l-on-primary"
        opacity="0.7"
      />
    </svg>
  );
}

export function LandingNav({ links, home = "#" }: { links: readonly NavLink[]; home?: string }) {
  const t = useTranslations("landing.nav");
  const brand = useTranslations("common")("brand");
  return (
    <nav
      aria-label={t("label")}
      className="mx-auto box-border flex w-full max-w-[1240px] flex-wrap items-center gap-x-7 gap-y-3 px-4 py-3.5 md:px-8 md:py-[22px]"
    >
      <a
        href={home}
        className="flex items-center gap-2.5 font-display text-lg font-bold text-l-text no-underline md:text-xl"
      >
        <Logo />
        {brand}
      </a>
      <div className="hidden flex-wrap gap-6 text-sm lg:flex">
        {links.map((l) => (
          <a key={l.href} href={l.href} className="text-l-text-2 no-underline hover:opacity-85">
            {l.label}
          </a>
        ))}
      </div>
      <div className="ml-auto flex items-center gap-2.5 md:gap-3">
        <ThemeToggle />
        <Link
          href="/signin"
          className="hidden text-sm font-semibold text-l-text no-underline hover:opacity-85 lg:inline"
        >
          {t("signIn")}
        </Link>
        <Link
          href="/signup"
          className="inline-flex min-h-11 items-center rounded-lg bg-l-primary px-3.5 text-sm font-semibold text-l-on-primary no-underline hover:opacity-90 md:px-[18px]"
        >
          {t("createAccount")}
        </Link>
        <LandingMenu links={links} />
      </div>
    </nav>
  );
}

/** Menu dưới 1024 px: các link anchor và Sign in. Đóng khi bấm một link, bấm ra ngoài hoặc Esc. */
function LandingMenu({ links }: { links: readonly NavLink[] }) {
  const t = useTranslations("landing.nav");
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (box.current?.contains(e.target as Node) !== true) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        btn.current?.focus();
      }
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  const close = () => {
    setOpen(false);
  };
  return (
    <div ref={box} className="relative lg:hidden">
      <button
        ref={btn}
        type="button"
        aria-label={open ? t("closeMenu") : t("menu")}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          setOpen((v) => !v);
        }}
        className="flex size-11 cursor-pointer items-center justify-center rounded-lg border border-l-btn-border bg-transparent text-l-text"
      >
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
          {open ? (
            <path d="M4 4l10 10M14 4L4 14" stroke="currentColor" strokeWidth="1.8" />
          ) : (
            <path d="M2 5h14M2 9h14M2 13h14" stroke="currentColor" strokeWidth="1.8" />
          )}
        </svg>
      </button>
      {open ? (
        <div
          id={id}
          className="absolute top-[calc(100%+8px)] right-0 z-50 flex w-[min(280px,calc(100vw-32px))] flex-col rounded-xl border border-l-line bg-l-surface p-2 shadow-lg"
        >
          {links.map((l) => (
            <a
              key={l.href}
              href={l.href}
              onClick={close}
              className="flex min-h-11 items-center rounded-lg px-3 text-[15px] font-semibold text-l-text no-underline hover:bg-l-surface-2"
            >
              {l.label}
            </a>
          ))}
          <div className="my-1 h-px bg-l-line" />
          <Link
            href="/signin"
            onClick={close}
            className="flex min-h-11 items-center rounded-lg px-3 text-[15px] font-semibold text-l-accent no-underline hover:bg-l-surface-2"
          >
            {t("signIn")}
          </Link>
        </div>
      ) : null}
    </div>
  );
}
