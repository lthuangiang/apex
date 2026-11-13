"use client";

import { DESK_AI_CONFIG } from "@drift/shared";
import { BottomSheet } from "@drift/ui";
import { useTranslations } from "next-intl";
import { useState } from "react";

// Desk AI nói rõ làm được gì (W6, câu chữ PM duyệt): khối "I can help with" khi khung chat còn trống, và link
// "What can Desk AI do?" ở chân khung chat mở cùng nội dung (sheet trên mobile, dialog giữa màn hình từ 768px; Radix
// giữ focus trong sheet, Esc để đóng, đóng xong focus về link).

const ITEMS = ["bots", "strategies", "market", "safety"] as const;

/** Nội dung dùng chung: tiêu đề, 4 việc làm được, câu "I can't …"; `quota` thì thêm "{n} questions a day." */
export function DeskAiCapabilities({
  quota = false,
  heading = true,
}: {
  quota?: boolean;
  /** false khi sheet đã có tiêu đề riêng. */
  heading?: boolean;
}) {
  const t = useTranslations("desk.ai.capabilities");
  return (
    <div className="flex flex-col gap-2 text-sm text-ink">
      {heading ? <p className="m-0 font-bold">{t("title")}</p> : null}
      <ul className="m-0 flex list-disc flex-col gap-1 pl-5">
        {ITEMS.map((k) => (
          <li key={k}>{t(`items.${k}`)}</li>
        ))}
      </ul>
      <p className="m-0 text-ink-2">{t("cannot")}</p>
      {quota ? (
        <p className="m-0 text-ink-2 tabular-nums">
          {t("perDay", { n: DESK_AI_CONFIG.dailyQuestions })}
        </p>
      ) : null}
    </div>
  );
}

/** Link ở chân khung chat, cạnh "Not financial advice". */
export function DeskAiCapabilitiesLink() {
  const t = useTranslations("desk.ai.capabilities");
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        onClick={() => {
          setOpen(true);
        }}
        className="font-semibold text-accent-ink underline"
      >
        {t("link")}
      </button>
      <BottomSheet open={open} onOpenChange={setOpen} title={t("title")} closeLabel={t("close")}>
        <DeskAiCapabilities quota heading={false} />
      </BottomSheet>
    </>
  );
}
