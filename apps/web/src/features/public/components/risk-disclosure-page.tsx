import { DRIFT_BUILDER_FEE_RATE } from "@drift/shared";
import { TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";

import { feeLabels } from "@/lib/format";

import { PublicFooter } from "./landing-page";
import { PublicHeader } from "./public-header";

// Risk Disclosure công khai (artboard "Public · Risk Disclosure", UI_REVIEW mục L). Trang pháp lý duy nhất:
// DRIFT là app cá nhân nên không có Terms / Privacy.

const SECTIONS = [
  { key: "loss" },
  { key: "leverage" },
  { key: "margin" },
  { key: "sharedLeverage" },
  { key: "strategy", items: ["grid", "dca", "recurring", "rebalancing", "funding", "twap"] },
  { key: "backtest" },
  { key: "technical", items: ["offline", "unknown", "key", "bugs"] },
  { key: "costs" },
  { key: "actions", items: ["limits", "botLimits", "halt", "revoke"] },
] as const;

export function RiskDisclosurePage({ signedIn }: { signedIn: boolean }) {
  const t = useTranslations("riskDisclosure");
  const { pct } = feeLabels(DRIFT_BUILDER_FEE_RATE);
  return (
    <div className="flex flex-col gap-5 bg-bg p-4 md:p-5">
      <PublicHeader signedIn={signedIn} />
      <div className="mx-auto box-border flex w-full max-w-[1180px] flex-wrap items-start gap-5">
        <nav
          aria-label={t("tocLabel")}
          className="box-border flex min-w-0 flex-[1_1_240px] flex-col gap-0.5 rounded-card border border-border bg-surface p-4 md:sticky md:top-5"
        >
          <span className="px-3 pt-1 pb-2 text-xs font-extrabold tracking-[0.08em] text-muted uppercase">
            {t("tocLabel")}
          </span>
          {SECTIONS.map((s, i) => (
            <a
              key={s.key}
              href={`#${s.key}`}
              className="flex min-h-9 items-center rounded-control px-3 text-sm font-semibold text-ink-2 no-underline hover:bg-surface-2 hover:text-ink"
            >
              {i + 1}. {t(`sections.${s.key}.title`)}
            </a>
          ))}
        </nav>
        <main className="box-border min-w-0 flex-[999_1_560px] rounded-card border border-border bg-surface p-[clamp(24px,4vw,48px)]">
          <span className="text-xs font-extrabold tracking-[0.08em] text-accent">
            {t("eyebrow")}
          </span>
          <h1 className="mt-2 mb-2 text-[clamp(30px,3.6vw,40px)] leading-[1.15] font-extrabold tracking-[-0.01em]">
            {t("title")}
          </h1>
          <p className="m-0 text-sm text-muted">{t("updated")}</p>
          <div
            role="note"
            className="mt-5 mb-2 flex gap-2.5 rounded-tile bg-neg-bg p-4 text-sm leading-relaxed text-neg-text"
          >
            <TriangleAlert
              size={20}
              className="mt-0.5 flex-none text-neg-deep"
              aria-hidden="true"
            />
            <span>
              <strong>{t("warnTitle")}</strong> {t("warnBody")}
            </span>
          </div>
          {SECTIONS.map((s, i) => (
            <section key={s.key} aria-labelledby={s.key}>
              <h2 id={s.key} className="mt-8 mb-2.5 scroll-mt-6 text-xl font-extrabold">
                {i + 1}. {t(`sections.${s.key}.title`)}
              </h2>
              {"items" in s ? (
                <ul className="m-0 flex flex-col gap-1 pl-[22px] text-[15px] leading-[1.7] text-ink-body">
                  {s.items.map((it) => (
                    <li key={it}>
                      {t.rich(`sections.${s.key}.items.${it}`, {
                        b: (chunks) => <strong>{chunks}</strong>,
                      })}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="m-0 text-[15px] leading-[1.7] text-ink-body">
                  {t(`sections.${s.key}.body`, { fee: pct })}
                </p>
              )}
            </section>
          ))}
        </main>
      </div>
      <PublicFooter />
    </div>
  );
}
