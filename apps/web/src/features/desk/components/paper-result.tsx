"use client";

import { deskBotsViewSchema, paperViewSchema } from "@drift/shared";
import { PnLValue } from "@drift/ui";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { api } from "@/lib/api";

import { plainUsd } from "../bplus";

// Desk AI › kết quả bài thử tiền ảo (artboard B-Result, DEC-164 vòng "theo tiếp"): khi một bot paper đã đủ ngày để kết
// luận (verdict khác `too_early`), panel báo kết quả bằng số mô phỏng có thật (paperView) và mở luồng "Use real money"
// hiện có (/desk/paper/:id/go-live: tính lại, kiểm tra, xác nhận). Không bắt đầu tiền thật ngay trong chat.
// "Keep testing a week" chỉ ẩn thẻ trên máy này 7 ngày (bài thử vẫn chạy).

const HIDE = "drift.desk.paperResultHidden";
const WEEK = 7 * 86_400_000;

function hiddenUntil(): Record<string, number> {
  try {
    return JSON.parse(window.localStorage.getItem(HIDE) ?? "{}") as Record<string, number>;
  } catch {
    return {};
  }
}

function ResultCard({ id, onKeep }: { id: string; onKeep: () => void }) {
  const t = useTranslations("desk.paperResult");
  const tr = useTranslations("desk.results");
  const tm = useTranslations("common.missing");
  const q = useQuery({
    queryKey: ["desk", "paper", id],
    queryFn: () => api("GET", `/api/v1/desk/paper/${id}`, paperViewSchema),
  });
  const v = q.data;
  if (v === undefined || v.verdict === "too_early") return null;
  return (
    <li className="flex gap-2">
      <span aria-hidden="true" className="text-accent-ink">
        ✦
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2 text-sm">
        <p className="m-0">
          {t("title", { name: v.bot.name, day: v.day })} {tr(`verdict.${v.verdict}`)}.
        </p>
        <dl className="m-0 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 rounded-[12px] bg-surface-2 px-3 py-2">
          <dt className="text-ink-2">{t("bot")}</dt>
          <dd className="m-0 text-right">
            <PnLValue
              value={v.net}
              locale="en-US"
              missingLabel={tm("notAvailable")}
              suffix=" USDC"
            />
          </dd>
          <dt className="text-ink-2">{t("hold", { asset: v.hold.asset })}</dt>
          <dd className="m-0 text-right">
            <PnLValue
              value={v.hold.amount}
              locale="en-US"
              missingLabel={tm("notAvailable")}
              suffix=" USDC"
            />
          </dd>
        </dl>
        <p className="m-0 text-xs text-muted">
          {t("foot", { capital: plainUsd(v.capital), day: v.day, fills: v.fills })}
        </p>
        <p className="m-0 text-xs text-ink-2">{t("note")}</p>
        <div className="flex flex-wrap gap-2">
          <Link
            href={`/desk/paper/${v.bot.id}/go-live`}
            className="inline-flex min-h-tap items-center rounded-[12px] bg-accent px-4 text-sm font-bold text-white hover:bg-accent-ink"
          >
            {t("start")}
          </Link>
          <button
            type="button"
            onClick={onKeep}
            className="inline-flex min-h-tap items-center rounded-[12px] border border-border-input bg-surface px-4 text-sm font-bold text-ink hover:bg-surface-2"
          >
            {t("keep")}
          </button>
          <Link
            href={`/desk/paper/${v.bot.id}/results`}
            className="inline-flex min-h-tap items-center text-sm font-bold text-accent-ink"
          >
            {t("open")}
          </Link>
        </div>
      </div>
    </li>
  );
}

export function PaperResults() {
  const bots = useQuery({
    queryKey: ["desk", "bots"],
    queryFn: () => api("GET", "/api/v1/desk/bots", deskBotsViewSchema),
  });
  const [hidden, setHidden] = useState<Record<string, number>>({});
  useEffect(() => {
    setHidden(hiddenUntil());
  }, []);
  const now = Date.now();
  const papers = (bots.data?.paper ?? []).filter(
    (p) => (hidden[p.bot.id] ?? 0) < now && p.bot.state !== "archived",
  );
  if (papers.length === 0) return null;
  return (
    <ul className="m-0 flex list-none flex-col gap-3 p-0">
      {papers.map((p) => (
        <ResultCard
          key={p.bot.id}
          id={p.bot.id}
          onKeep={() => {
            const next = { ...hidden, [p.bot.id]: Date.now() + WEEK };
            setHidden(next);
            try {
              window.localStorage.setItem(HIDE, JSON.stringify(next));
            } catch {
              // Không lưu được (chế độ riêng tư): vẫn ẩn trong phiên này.
            }
          }}
        />
      ))}
    </ul>
  );
}
