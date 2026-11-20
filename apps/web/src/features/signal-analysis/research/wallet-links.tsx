"use client";

import type { ResearchSignalContext, ResearchWalletRef, ResearchWallets } from "@drift/shared";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { useFeatures } from "@/lib/queries";

import { monthDay } from "../format";

import { useResearchWallets } from "./api";
import { Na, Pill, tdR, thR } from "./ui";

// Ví nghiên cứu (#353, DEC-TBD-sr-research-wallet-list; thiết kế scratchpad rwlist-mockup đã duyệt): danh sách trong khu
// "Bots & labels" và link ví cùng / ngược chiều trên thẻ H1 của bước 4. Link tới trang có sẵn `/traders/[address]` chỉ khi
// người xem bật AI Desk (`useFeatures().data.aiDesk`, cùng nguồn với workspace shell) VÀ ví có trang trader (`hasProfile`).
// Không có AI Desk: địa chỉ chữ thường kèm "Turn on AI Desk to open trader pages", không bao giờ dẫn tới trang 403.

/** "0x9c3f…a1e2". */
export const shortAddress = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Người xem mở được trang trader (API hồ sơ cần AI Desk). Chưa biết (đang tải / lỗi) = không. */
export function useCanOpenTraders(): boolean {
  return useFeatures().data?.aiDesk === true;
}

const linkCls = "font-mono font-bold text-accent-ink underline-offset-2 hover:underline";

export function WalletAddress({
  wallet,
  canOpen,
}: {
  wallet: ResearchWalletRef;
  canOpen: boolean;
}) {
  const label = shortAddress(wallet.address);
  if (canOpen && wallet.hasProfile)
    return (
      <Link href={`/traders/${wallet.address}`} className={linkCls} title={wallet.address}>
        {label}
      </Link>
    );
  return (
    <span className="font-mono text-ink-2" title={wallet.address}>
      {label}
    </span>
  );
}

/** Tối đa ngần này ví mỗi phía trên thẻ H1; còn lại "+N more". */
export const H1_WALLETS_SHOWN = 3;

/**
 * Dòng ví của thẻ H1: Yes → "Same way:" (ví cùng chiều), Disagree → "Other way:" (ví ngược chiều). Snapshot cũ không lưu địa
 * chỉ (null) hoặc danh sách rỗng → không hiện gì (thẻ vẫn có số lượng).
 */
export function H1Wallets({
  context,
  canOpen,
}: {
  context: ResearchSignalContext;
  canOpen: boolean;
}) {
  const t = useTranslations("signalAnalysis.research");
  const h = context.h1;
  const side = h.status === "yes" ? "same" : h.status === "against" ? "other" : null;
  const list = side === "same" ? h.agreeing : side === "other" ? h.opposing : null;
  if (side === null || list === null || list.length === 0) return null;
  const shown = list.slice(0, H1_WALLETS_SHOWN);
  const more = list.length - shown.length;
  return (
    <div data-testid="sr-ctx-h1-wallets" className="flex flex-col gap-1">
      <p className="m-0 text-xs leading-[1.45] text-ink-2">
        {t(side === "same" ? "context.h1.sameWay" : "context.h1.otherWay")}{" "}
        {shown.map((w, i) => (
          <span key={w.address}>
            {i > 0 ? " · " : null}
            <WalletAddress wallet={w} canOpen={canOpen} />
          </span>
        ))}
        {more > 0 ? ` · ${t("context.h1.more", { n: more })}` : null}
      </p>
      {canOpen ? null : <p className="m-0 text-xs text-muted">{t("traders.noDesk")}</p>}
    </div>
  );
}

/** Số dòng hiện trước khi bấm "Show all {K}". */
export const RESEARCH_WALLETS_SHOWN = 5;

/** Phút kể từ lần đọc được (≥ 1, để không ghi "0 min"). */
const minsAgo = (iso: string, now: number): number =>
  Math.max(1, Math.round((now - Date.parse(iso)) / 60_000));

/** Bảng ví nghiên cứu (không có dữ liệu thì trạng thái rỗng; set chỉ ghi một lần ở tiêu đề). */
export function ResearchWalletsTable({
  data,
  canOpen,
  now,
}: {
  data: ResearchWallets;
  canOpen: boolean;
  now: number;
}) {
  const t = useTranslations("signalAnalysis.research.researchWallets");
  const tt = useTranslations("signalAnalysis.research.traders");
  const [all, setAll] = useState(false);
  const set = data.set;
  if (set === null)
    return (
      <section aria-labelledby="sr-rw-title" className="flex flex-col gap-2">
        <h3 id="sr-rw-title" className="m-0 text-base font-extrabold">
          {t("titleNoK")}
        </h3>
        <p className="m-0 rounded-tile border border-dashed border-border px-4 py-3 text-[13px] text-muted">
          {t("empty")}
        </p>
      </section>
    );
  const read = data.items.filter((w) => w.readRecently).length;
  const rows = all ? data.items : data.items.slice(0, RESEARCH_WALLETS_SHOWN);
  const title = t("title", { k: set.size });
  return (
    <section aria-labelledby="sr-rw-title" className="flex min-w-0 flex-col gap-2.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 id="sr-rw-title" className="m-0 text-base font-extrabold">
            {title}
          </h3>
          <p className="m-0 text-[13px] text-muted">
            {t("sub", { n: read, k: set.size, mins: data.windowMinutes })}
          </p>
        </div>
        <Pill tone="accent">
          {t("chip", { v: set.version, date: monthDay(`${set.runDate}T00:00:00Z`, "UTC") })}
        </Pill>
      </div>
      {data.items.length === 0 ? (
        <p className="m-0 rounded-tile border border-dashed border-border px-4 py-3 text-[13px] text-muted">
          {t("emptySet")}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-tile border border-border">
          <table className="w-full min-w-[560px] border-collapse">
            <caption className="sr-only">{title}</caption>
            <thead>
              <tr>
                <th scope="col" className={`${thR} w-20`}>
                  {t("colRank")}
                </th>
                <th scope="col" className={thR}>
                  {t("colWallet")}
                </th>
                <th scope="col" className={thR}>
                  {t("colRead")}
                </th>
                <th scope="col" className={`${thR} text-right`}>
                  {t("colPage")}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((w) => (
                <tr key={w.address}>
                  <td className={tdR}>{t("rank", { n: w.rank })}</td>
                  <td className={tdR}>
                    <WalletAddress wallet={w} canOpen={canOpen} />
                  </td>
                  <td className={tdR}>
                    {w.readRecently && w.lastReadAt !== null ? (
                      t("read", { n: minsAgo(w.lastReadAt, now) })
                    ) : (
                      <Pill tone="warn">{t("notRead", { mins: data.windowMinutes })}</Pill>
                    )}
                  </td>
                  <td className={`${tdR} text-right`}>
                    {!w.hasProfile ? (
                      <span className="text-muted">{t("noPage")}</span>
                    ) : canOpen ? (
                      <Link
                        href={`/traders/${w.address}`}
                        className="font-bold text-accent-ink underline-offset-2 hover:underline"
                        aria-label={t("openAria", { wallet: shortAddress(w.address) })}
                      >
                        {t("open")}
                      </Link>
                    ) : (
                      <Na />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {all || data.items.length <= RESEARCH_WALLETS_SHOWN ? null : (
            <div className="border-t border-bg py-2.5 text-center">
              <button
                type="button"
                className="min-h-11 cursor-pointer border-0 bg-transparent px-3 font-bold text-accent-ink underline-offset-2 hover:underline"
                onClick={() => {
                  setAll(true);
                }}
              >
                {t("showAll", { k: data.items.length })}
              </button>
            </div>
          )}
        </div>
      )}
      <p className="m-0 text-[13px] text-muted">{t("note")}</p>
      {canOpen ? null : <p className="m-0 text-[13px] text-muted">{tt("noDesk")}</p>}
    </section>
  );
}

/** Khối trong "Bots & labels": tải khi khu mở. */
export function ResearchWalletsBlock({ open }: { open: boolean }) {
  const q = useResearchWallets(open);
  const canOpen = useCanOpenTraders();
  if (q.data === undefined) {
    if (q.isError) return <Na />;
    return null;
  }
  return <ResearchWalletsTable data={q.data} canOpen={canOpen} now={Date.now()} />;
}
