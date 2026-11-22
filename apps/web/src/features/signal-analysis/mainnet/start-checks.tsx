"use client";

import type { StartChecks } from "@drift/shared";
import { ChecklistRow } from "@drift/ui";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useRef } from "react";

import { formatMoney } from "@/lib/format";

import { useNewsBotChecks } from "./api";
import { useMainnetErrorText } from "./text";

// Danh sách kiểm tra trong hộp "Start v1?" của bot Mainnet (#459): đọc `GET /bots/:id/checks` khi mở hộp (và đọc lại
// sau mỗi lần Start lỗi), mỗi check một dòng ✓ / ✕; dòng sai nói rõ check nào và việc cần làm. Tên dòng và câu của dòng
// đạt dùng lại câu chữ "Before it starts" của form tạo bot; câu của dòng sai là câu PM duyệt cho bot Mainnet. Số tiền lấy
// từ API, thiếu thì "Not available", không bao giờ 0 (quy tắc 1.8).

type Check = StartChecks["checks"][number];

/** #458: số của config bot để ghi công thức margin (size × Max open ÷ đòn bẩy); số "needed" vẫn lấy từ API. */
export interface MarginFormula {
  size: string;
  n: number;
  lev: number;
}

const usdc = (v: string | null | undefined) =>
  v === null || v === undefined ? null : (formatMoney(v) ?? v);

export function NewsStartChecks({
  botId,
  failure,
  formula = null,
}: {
  botId: string;
  formula?: MarginFormula | null;
  /** Lỗi của lần Start gần nhất; đổi (khác null) thì đọc lại danh sách kiểm tra. */
  failure: string | null;
}) {
  const t = useTranslations("signalAnalysis.research.mainnet.dialogs.start.checks");
  const tb = useTranslations("createBot.beforeStart");
  const tce = useTranslations("createBot.errors");
  const tm = useTranslations("signalAnalysis.research.mainnet");
  const tr = useTranslations("signalAnalysis.research");
  const tn = useTranslations("common.nav");
  const errorText = useMainnetErrorText();
  const q = useNewsBotChecks(botId, true);
  const { refetch } = q;
  const last = useRef(failure);
  useEffect(() => {
    if (failure !== null && failure !== last.current) void refetch();
    last.current = failure;
  }, [failure, refetch]);

  if (q.isPending)
    return (
      <p role="status" className="m-0 text-sm text-muted">
        {tm("loading")}
      </p>
    );
  if (q.isError)
    return (
      <p role="alert" className="m-0 text-sm font-semibold text-neg-ink">
        {errorText(q.error)}
      </p>
    );

  const failDetail = (c: Check): string => {
    const d = c.data ?? {};
    switch (c.key) {
      case "api_key":
        return t("apiKey");
      case "builder_fee":
        return tce("builderFee");
      case "balance": {
        const needed = usdc(d.needed) ?? tr("na");
        // Thiếu số available: câu riêng (review #461), không chèn "Not available" vào giữa câu.
        const a = usdc(d.available);
        return a === null ? t("balanceNa", { needed }) : t("balance", { available: a, needed });
      }
      case "leverage_conflict":
        return c.detail === "bot" && d.market != null && d.botName != null
          ? t("leverageBot", { market: d.market, botName: d.botName })
          : tm("errors.leverageConflict");
      // Bot Mainnet không có các check này (newsStartChecks); có thì dùng câu của form tạo bot.
      case "fresh_price":
      case "min_size":
      case "risk_limits":
      case "two_factor":
        return tb(`failDetail.${c.key}`);
    }
  };
  const okDetail = (c: Check) =>
    c.key === "builder_fee" && c.detail === "exempt"
      ? tb("okDetail.builder_fee_exempt")
      : tb(`okDetail.${c.key}`);

  return (
    <ul aria-label={tb("title")} className="m-0 flex list-none flex-col gap-1.5 p-0">
      {q.data.checks.map((c) => (
        <li
          key={c.key}
          data-check={c.key}
          className={`flex flex-col gap-1 rounded-control px-3 py-1.5 ${c.ok ? "bg-surface-2" : "bg-neg-soft"}`}
        >
          <ChecklistRow
            status={c.ok ? "pass" : "fail"}
            statusLabel={c.ok ? tb("passed") : tb("failed")}
            label={tb(c.key, { engine: "perps" })}
            detail={c.ok ? okDetail(c) : failDetail(c)}
          />
          {c.key === "balance" && formula !== null ? (
            <p data-testid="margin-formula" className="m-0 pb-1 pl-9 text-xs text-muted">
              {t("formula", { size: formula.size, n: formula.n, lev: formula.lev })}
            </p>
          ) : null}
          {!c.ok && (c.key === "api_key" || c.key === "builder_fee") ? (
            <Link
              href="/settings"
              className="self-start pb-1 text-[13px] font-bold text-accent-ink"
            >
              {tn("settings")} →
            </Link>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
