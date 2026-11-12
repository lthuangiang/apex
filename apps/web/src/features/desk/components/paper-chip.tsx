import { useTranslations } from "next-intl";

/** Nhãn PAPER (DEC-105): mọi nơi hiện bot paper đều có nhãn này, không bao giờ để lẫn với bot tiền thật. */
export function PaperChip({ short = false }: { short?: boolean }) {
  const t = useTranslations("desk");
  return (
    <span className="inline-flex h-6 flex-none items-center rounded-full bg-warn-bg px-2.5 text-[11px] font-extrabold tracking-[0.04em] whitespace-nowrap text-warn">
      {short ? t("paperTag") : t("paperChip")}
    </span>
  );
}
