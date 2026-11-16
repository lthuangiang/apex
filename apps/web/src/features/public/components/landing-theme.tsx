"use client";

import { useTranslations } from "next-intl";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import { LANDING_FONTS } from "../landing-fonts";
import { LANDING_THEME_COOKIE, type LandingTheme } from "../landing-theme-cookie";

// Theme của landing và trang MCP (DEC trong PR #166): mặc định SÁNG; nút mặt trời / mặt trăng đổi theme và nhớ lựa chọn
// (localStorage, bọc try/catch: trình duyệt chặn storage thì vẫn chạy, chỉ không nhớ). App không dùng theme này.

export type { LandingTheme };
const KEY = "desklabs.landing.theme";

const Ctx = createContext<{ theme: LandingTheme; toggle: () => void }>({
  theme: "light",
  toggle: () => undefined,
});

function readStored(): LandingTheme | null {
  try {
    const v = window.localStorage.getItem(KEY);
    return v === "dark" || v === "light" ? v : null;
  } catch {
    return null;
  }
}

function store(theme: LandingTheme): void {
  try {
    window.localStorage.setItem(KEY, theme);
  } catch {
    // Không nhớ được (private mode, storage bị chặn): theme vẫn đổi trong phiên này.
  }
  try {
    document.cookie = `${LANDING_THEME_COOKIE}=${theme}; path=/; max-age=31536000; samesite=lax`;
  } catch {
    // Cookie bị chặn: lần sau có thể chớp sáng một nhịp, theme vẫn đúng sau khi đọc localStorage.
  }
}

/** Khối gốc của landing / trang MCP: token màu `l-*`, font mới, theme. */
export function LandingShell({
  children,
  initialTheme = null,
}: {
  children: ReactNode;
  /** Theme đọc từ cookie ở server; null → mặc định sáng, rồi đọc localStorage. */
  initialTheme?: LandingTheme | null;
}) {
  const [theme, setTheme] = useState<LandingTheme>(initialTheme ?? "light");
  useEffect(() => {
    if (initialTheme !== null) return;
    const saved = readStored();
    if (saved !== null) setTheme(saved);
  }, [initialTheme]);
  const toggle = () => {
    setTheme((t) => {
      const next = t === "dark" ? "light" : "dark";
      store(next);
      return next;
    });
  };
  return (
    <Ctx.Provider value={{ theme, toggle }}>
      <div data-theme={theme} className={`landing ${LANDING_FONTS} min-h-screen font-body`}>
        {children}
      </div>
    </Ctx.Provider>
  );
}

/** Nút mặt trời / mặt trăng trong nav. */
export function ThemeToggle() {
  const t = useTranslations("landing.nav");
  const { theme, toggle } = useContext(Ctx);
  const dark = theme === "dark";
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={dark ? t("themeLight") : t("themeDark")}
      className="flex size-11 cursor-pointer items-center justify-center rounded-lg border border-l-btn-border bg-transparent text-l-text"
    >
      {dark ? (
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
          <circle cx="9" cy="9" r="3.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <path
            d="M9 1.5v2M9 14.5v2M1.5 9h2M14.5 9h2M3.7 3.7l1.4 1.4M12.9 12.9l1.4 1.4M3.7 14.3l1.4-1.4M12.9 5.1l1.4-1.4"
            stroke="currentColor"
            strokeWidth="1.6"
          />
        </svg>
      ) : (
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
          <path
            d="M14.5 11.2A6 6 0 0 1 6.8 3.5a6 6 0 1 0 7.7 7.7z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
          />
        </svg>
      )}
    </button>
  );
}
