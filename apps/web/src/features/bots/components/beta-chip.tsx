"use client";

import { useTranslations } from "next-intl";

// Nhãn "Beta" cho chiến lược còn đang thử (DEC-TBD-adaptive-dca-beta): thẻ catalog, trang tạo / sửa bot, hàng bot ở My
// bots, Trading Agent. Một kiểu chữ ("Beta") và một câu ngắn. Câu ngắn hiện thẳng ở trang tạo / sửa và Trading Agent;
// ở chỗ chật (thẻ, hàng) thì nằm trong `title` và phần chữ cho trình đọc màn hình.

/** Chiến lược đang Beta. */
export const BETA_STRATEGIES: readonly string[] = ["adaptive_dca"];
export const isBeta = (strategy: string): boolean => BETA_STRATEGIES.includes(strategy);

const CHIP =
  "inline-flex flex-none items-center rounded-full bg-accent-tint px-2 py-0.5 text-[11px] font-extrabold whitespace-nowrap text-accent-ink";

/** Chip "Beta"; `note` thì kèm câu "Still being tested. Use small amounts." ngay cạnh. */
export function BetaChip({ note = false }: { note?: boolean }) {
  const t = useTranslations("beta");
  if (note)
    return (
      <span className="inline-flex flex-wrap items-center gap-2 text-[13px] text-ink-2">
        <span className={CHIP}>{t("label")}</span>
        {t("note")}
      </span>
    );
  return (
    <span className={CHIP} title={t("note")}>
      {t("label")}
      <span className="sr-only">: {t("note")}</span>
    </span>
  );
}
