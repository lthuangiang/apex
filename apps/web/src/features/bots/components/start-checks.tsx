"use client";

import { startChecksSchema, type StartChecks } from "@drift/shared";
import { STRATEGIES } from "@drift/strategies";
import { ChecklistRow } from "@drift/ui";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { api } from "@/lib/api";
import { formatMoney } from "@/lib/format";

import { toConfig, type FIELDS, type FormValues } from "../fields";

// "Before it starts" chạy trực tiếp trên form chưa lưu (UI_REVIEW H2): `POST /api/v1/bots/checks` (dry run, không
// ghi DB), debounce 500 ms, chỉ khi config hợp lệ theo zod schema của chiến lược. Con số trong mỗi check lấy từ
// API, không tự tính lại ở client.

type Strategy = keyof typeof FIELDS;
type Check = StartChecks["checks"][number];

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => {
      setV(value);
    }, ms);
    return () => {
      clearTimeout(id);
    };
  }, [value, ms]);
  return v;
}

export function useDryRunChecks(strategy: Strategy, values: FormValues) {
  const config = toConfig(strategy, values);
  const valid = STRATEGIES[strategy].schema.safeParse(config).success;
  const key = useDebounced(valid ? JSON.stringify(config) : null, 500);
  const q = useQuery({
    queryKey: ["checks-dry", strategy, key],
    queryFn: () =>
      api("POST", "/api/v1/bots/checks", startChecksSchema, {
        body: { strategy, config: JSON.parse(key ?? "{}") as Record<string, unknown> },
      }),
    enabled: key !== null,
    refetchInterval: 10_000,
    placeholderData: (prev) => prev,
  });
  return { valid, query: q, settled: key === (valid ? JSON.stringify(config) : null) };
}

const money = (v: string | null | undefined) =>
  v === null || v === undefined ? "" : (formatMoney(v) ?? v);

/** Chỉ khác cài đặt đòn bẩy (không vị thế): cảnh báo vàng + xác nhận riêng trước khi Start (DEC-58). */
export function leverageWarning(checks: StartChecks | undefined) {
  const c = checks?.checks.find((x) => x.key === "leverage_conflict");
  return c?.ok === true && c.detail === "changes" && c.data !== undefined ? c.data : null;
}

export function CheckList({ checks, engine }: { checks: StartChecks; engine: string }) {
  const t = useTranslations("createBot.beforeStart");
  const detail = (c: Check) => {
    if (c.ok)
      return c.detail === "exempt" ? t("okDetail.builder_fee_exempt") : t(`okDetail.${c.key}`);
    const d = c.data ?? {};
    if (c.key === "min_size" && d.smallest != null && d.required != null) {
      if (d.suggestedCapital == null)
        return t("failDetail.min_sizeNoSuggestion", {
          min: money(d.smallest),
          required: money(d.required),
        });
      return t(
        d.capitalField === "investment" || d.capitalField === "margin"
          ? "failDetail.min_sizeNumbersGrid"
          : "failDetail.min_sizeNumbers",
        {
          min: money(d.smallest),
          required: money(d.required),
          capital: money(d.suggestedCapital),
        },
      );
    }
    if (c.key === "balance" && d.needed != null && d.usableMargin !== undefined)
      return t("failDetail.balancePerps", {
        needed: money(d.needed),
        usable: d.usableMargin == null ? "—" : money(d.usableMargin),
        isolated: d.isolated == null ? "—" : money(d.isolated),
      });
    if (c.key === "leverage_conflict" && d.currentLeverage != null) {
      const current = t("leverageValue", {
        leverage: d.currentLeverage,
        mode: d.currentMode ?? "",
      });
      return c.detail === "bot"
        ? t("failDetail.leverage_bot", {
            name: d.botName ?? "",
            market: d.market ?? "",
            current,
          })
        : t("failDetail.leverage_position", { market: d.market ?? "", current });
    }
    if (c.key === "balance" && d.needed != null)
      return t("failDetail.balanceNumbers", {
        available: d.available == null ? "—" : money(d.available),
        needed: money(d.needed),
      });
    if (c.key === "fresh_price") return t("failDetail.fresh_priceWaiting");
    if (c.key === "api_key" && c.detail === "unusable") return t("failDetail.api_keyUnusable");
    return t(`failDetail.${c.key}`);
  };
  return (
    <ul className="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-2 p-0">
      {checks.checks.map((c) => (
        <li
          key={c.key}
          id={`check-${c.key}`}
          className={`flex flex-col gap-1.5 rounded-control px-3 py-2.5 ${c.ok ? "bg-surface-2" : "bg-neg-soft"}`}
        >
          <ChecklistRow
            status={c.ok ? "pass" : "fail"}
            statusLabel={c.ok ? "✓" : "✕"}
            label={t(c.key, { engine })}
            detail={detail(c)}
          />
          {!c.ok && (c.key === "api_key" || c.key === "builder_fee" || c.key === "two_factor") ? (
            <Link
              href={c.key === "two_factor" ? "/settings?tab=security" : "/settings"}
              className="self-start text-[13px] font-bold text-accent-ink"
            >
              {c.key === "api_key" ? t("renewKey") : t(`failDetail.${c.key}`)} →
            </Link>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
