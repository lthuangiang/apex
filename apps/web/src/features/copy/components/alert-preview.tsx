"use client";

import type { FollowAlertLevel } from "@drift/shared";
import Link from "next/link";
import { useTranslations } from "next-intl";

// Thẻ "Alert preview" ở Following (artboard WhaleWatch, W4): xem trước tin sẽ nhận theo mức cảnh báo đang chọn của
// một trader. Số trong thẻ là VÍ DỤ cố định (ghi rõ "Example"), không phải giao dịch thật và không tính từ dữ liệu
// (quy tắc 1.8). Tên trader là thật. Đang copy trader này thì tin follow tạm tắt (DEC-212): thẻ nói rõ.

const CARD =
  "flex flex-col gap-2.5 rounded-[20px] border-[1.5px] border-warn-bar bg-surface px-[18px] py-4 shadow-lg";

export function AlertPreview({
  trader,
  address,
  level,
  copying,
}: {
  trader: string;
  address: string;
  level: FollowAlertLevel;
  copying: boolean;
}) {
  const t = useTranslations("copy.following.preview");
  return (
    <section aria-labelledby="fl-preview" className="flex min-w-0 flex-[2_1_340px] flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <h2
          id="fl-preview"
          className="m-0 text-xs font-extrabold tracking-[0.08em] text-ink-2 uppercase"
        >
          {t("title")}
        </h2>
        <span className="inline-flex items-center rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-extrabold text-ink-2">
          {t("example")}
        </span>
      </div>
      <p className="m-0 text-xs text-muted">{t("forTrader", { trader })}</p>
      {copying ? (
        <p className="m-0 rounded-[14px] border border-border bg-surface px-4 py-3 text-[13px] leading-normal text-ink-2">
          {t("copying")}
        </p>
      ) : level === "off" ? (
        <p className="m-0 rounded-[14px] border border-border bg-surface px-4 py-3 text-[13px] leading-normal text-ink-2">
          {t("off", { trader })}
        </p>
      ) : (
        <>
          <div className={CARD}>
            <div className="flex items-center gap-2.5">
              <strong className="text-[14.5px]">{t("bigMove.title", { trader })}</strong>
              <span className="ml-auto text-xs text-ink-2 tabular-nums">{t("bigMove.seen")}</span>
            </div>
            <p className="m-0 text-[13.5px] leading-normal text-ink-body tabular-nums">
              <strong className="text-pos">{t("bigMove.change")}</strong> {t("bigMove.detail")}
            </p>
            <p className="m-0 text-[12.5px] leading-normal text-ink-2">{t("bigMove.note")}</p>
          </div>
          {level === "positions" ? (
            <div className={CARD}>
              <strong className="text-[14.5px]">{t("position.title", { trader })}</strong>
              <p className="m-0 text-[12.5px] leading-normal text-ink-2">{t("position.note")}</p>
            </div>
          ) : null}
        </>
      )}
      <Link
        href={`/traders/${address}`}
        className="inline-flex min-h-10 items-center self-start rounded-[12px] border border-border px-3.5 text-[13.5px] font-bold text-ink no-underline"
      >
        {t("viewTrader")}
      </Link>
    </section>
  );
}
