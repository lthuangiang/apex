"use client";

import {
  AssetMode,
  BotState,
  botDetailSchema,
  dec,
  Decimal,
  NEWS_RULES,
  newsSignalConfigSchema,
  SIGNAL_CATALYSTS,
  type NewsBotVersionResult,
  type NewsSignalConfig,
} from "@drift/shared";
import { BottomSheet, Button } from "@drift/ui";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState, type ReactNode } from "react";

import { api } from "@/lib/api";

import { clock, monthDay } from "../format";
import { useResearchVersions } from "../research/api";
import { hold } from "../research/format";
import { Na, Pill } from "../research/ui";
import { catalystName, catalystSide, versionShort } from "../research/version-text";

import { BotEditSheet } from "./bot-edit";
import { useMarketsText } from "./text";

// Màn Settings (chỉ xem) của bot `news_signal` Mainnet (#469 phần 1, mockup docs/mockups/signal-research/news-signal-settings.html
// khung 2): cấu hình của version đang chạy (`GET /bots/:id`, version `active`). Không sửa được ở đây (Edit là phần 2).
// Thiếu dữ liệu thì "Not available", không bao giờ 0 (quy tắc 1.8). Bot cũ không có trường `leverage` đọc là 1× (schema).
// "Copied from version …" chỉ hiện khi API trả version gốc và version đó còn trong danh sách người xem thấy được.
// #469 phần 2: nút Edit mở form lưu thành version mới (`bot-edit.tsx`); version `pending` → "Applying v{n}…" và Edit khoá
// tới khi engine xác nhận (quy tắc 1.6).

/** Trạng thái bot sửa được (như API): không đang chuyển trạng thái, chưa archive. */
const EDITABLE_STATES: readonly string[] = [
  BotState.running,
  BotState.paused,
  BotState.draft,
  BotState.stopped,
];

/**
 * Version của bot: version đang chạy (số, lúc áp, config đã parse; null khi đọc không được), version `pending` mới nhất
 * (đang chờ engine áp; null = không có) và số của version kế tiếp. Còn version chờ thì đọc lại mỗi giây.
 */
export function useActiveBotVersion(botId: string | null) {
  const q = useQuery({
    queryKey: ["bot", botId],
    queryFn: () => api("GET", `/api/v1/bots/${botId ?? ""}`, botDetailSchema),
    enabled: botId !== null,
    refetchInterval: (query) =>
      query.state.data?.versions.some((v) => v.status === "pending") === true ? 1_000 : 10_000,
  });
  const versions = q.data?.versions ?? [];
  const active = versions.find((v) => v.status === "active") ?? null;
  const pending = versions
    .filter((v) => v.status === "pending")
    .reduce<number | null>((m, v) => (m === null || v.version > m ? v.version : m), null);
  const parsed = newsSignalConfigSchema.safeParse(active?.config);
  return {
    query: q,
    version: active?.version ?? null,
    since: active?.appliedAt ?? null,
    config: parsed.success ? parsed.data : null,
    pending,
    next: versions.length === 0 ? null : Math.max(...versions.map((v) => v.version)) + 1,
  };
}

/** Ký quỹ USDC làm tròn lên 2 chữ số (không bao giờ báo thấp hơn thực tế), bỏ số 0 thừa. */
const marginText = (v: Decimal) => v.toDecimalPlaces(2, Decimal.ROUND_UP).toString();

export function BotSettingsSheet({
  botId,
  name,
  state,
  signalVersionId,
  account,
  tz,
  onClose,
}: {
  botId: string;
  name: string;
  /** Trạng thái bot từ backend: Edit khoá khi đang chuyển trạng thái / archive. */
  state: string;
  /** Version gốc từ API; null = không biết (ẩn dòng "Copied from"). */
  signalVersionId: string | null;
  /** "••4f2a" khi đã kết nối; null = không biết. */
  account: string | null;
  tz: string;
  onClose: () => void;
}) {
  const t = useTranslations("signalAnalysis.research.mainnet.settings");
  const tm = useTranslations("signalAnalysis.research.mainnet");
  const tv = useTranslations("signalAnalysis.research.versions");
  const a = useActiveBotVersion(botId);
  const versions = useResearchVersions();
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState<NewsBotVersionResult | null>(null);
  const source =
    signalVersionId === null
      ? null
      : (versions.data?.items.find((v) => v.id === signalVersionId) ?? null);
  const canEdit =
    a.config !== null && a.next !== null && a.pending === null && EDITABLE_STATES.includes(state);
  if (editing && a.config !== null && a.next !== null)
    return (
      <BotEditSheet
        botId={botId}
        name={name}
        current={a.config}
        source={source?.config ?? null}
        next={a.next}
        onClose={() => {
          setEditing(false);
        }}
        onSaved={(r) => {
          setSaved(r);
          setEditing(false);
        }}
      />
    );
  const since =
    a.version === null || a.since === null
      ? null
      : t("since", {
          n: a.version,
          time: `${monthDay(a.since, tz)}, ${clock(a.since, tz, false)}`,
        });

  return (
    <BottomSheet
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={name}
      titleAside={
        <span className="flex flex-wrap items-center gap-2">
          <Pill tone="neg">{tm("strip.mainnet")}</Pill>
          {since === null ? null : (
            <span className="rounded-full bg-surface-2 px-2.5 py-0.5 text-xs font-extrabold text-ink-2">
              {since}
            </span>
          )}
          {a.pending === null ? null : <ApplyingChip n={a.pending} />}
        </span>
      }
      {...(source === null ? {} : { description: t("copied", { name: versionShort(source, tv) }) })}
      closeLabel={tv("sheet.close")}
      side
      footer={
        <div className="flex w-full flex-col gap-2 md:flex-row md:justify-end">
          <Button variant="secondary" onClick={onClose}>
            {tv("sheet.close")}
          </Button>
          <Button
            disabled={!canEdit}
            onClick={() => {
              setSaved(null);
              setEditing(true);
            }}
          >
            {t("edit")}
          </Button>
        </div>
      }
    >
      {saved === null ? null : <SavedNote result={saved} />}
      <BotSettingsBody botId={botId} account={account} />
    </BottomSheet>
  );
}

/**
 * Nội dung chỉ xem của Settings (nhóm Bot / Signals / News types), dùng chung cho sheet Settings của Signal Research và
 * khối Configuration của Trading Agent (#470). Đọc version `active` của bot; thiếu dữ liệu thì "Not available".
 */
export function BotSettingsBody({ botId, account }: { botId: string; account: string | null }) {
  const t = useTranslations("signalAnalysis.research.mainnet.settings");
  const te = useTranslations("signalAnalysis.research.mainnet.editor");
  const tm = useTranslations("signalAnalysis.research.mainnet");
  const tv = useTranslations("signalAnalysis.research.versions");
  const tn = useTranslations("signalAnalysis.research");
  const a = useActiveBotVersion(botId);
  const cfg = a.config;
  return a.query.isPending ? (
    <p role="status" className="m-0 text-sm text-muted">
      {tm("loading")}
    </p>
  ) : (
    <>
      <Group legend={te("botBlock")}>
        <Kv label={te("account")} mono={account !== null}>
          {account ?? <Na />}
        </Kv>
        <Kv label={te("leverage")}>
          {cfg === null ? <Na /> : t("leverageValue", { lev: cfg.leverage })}
        </Kv>
        <Kv label={te("size")}>{cfg === null ? <Na /> : te("usdc", { v: cfg.sizeUsdc })}</Kv>
        <Kv label={t("marginPerTrade")}>
          {cfg === null ? (
            <Na />
          ) : (
            te("usdc", { v: marginText(dec(cfg.sizeUsdc).div(cfg.leverage)) })
          )}
        </Kv>
        <Kv label={tv("sheet.maxOpen")}>{cfg === null ? <Na /> : String(cfg.maxOpenTrades)}</Kv>
        <Kv label={t("maxDay")}>
          {cfg === null ? (
            <Na />
          ) : cfg.maxNewTradesPerDay === null ? (
            t("noLimit")
          ) : (
            String(cfg.maxNewTradesPerDay)
          )}
        </Kv>
      </Group>
      <Group legend={t("signals")}>
        <Kv label={t("markets")}>{cfg === null ? <Na /> : <Markets cfg={cfg} />}</Kv>
        <Kv label={t("minLevel")}>{cfg === null ? <Na /> : tn(`levels.${cfg.minLevel}`)}</Kv>
        <Kv label={t("tpsl")}>
          {cfg === null ? <Na /> : t("tpslValue", { tp: cfg.tpMultiple, sl: cfg.slMultiple })}
        </Kv>
        <Kv label={t("maxDelay")}>
          {cfg === null ? <Na /> : t("delayValue", { n: cfg.maxSourceDelayMinutes })}
        </Kv>
      </Group>
      <fieldset className="m-0 min-w-0 rounded-tile border border-border px-3.5 pt-2 pb-3.5">
        <legend className="px-1.5 text-[15px] font-extrabold text-ink">
          {tv("sheet.newsTypes")}
        </legend>
        {cfg === null ? (
          <Na />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13.5px]">
              <caption className="sr-only">{tv("sheet.newsTable")}</caption>
              <thead>
                <tr>
                  {(["colTrade", "colType", "colDir", "colHold"] as const).map((k) => (
                    <th
                      key={k}
                      scope="col"
                      className="border-b border-border px-2 py-2 text-left text-xs font-bold text-muted"
                    >
                      {tv(`sheet.${k}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {SIGNAL_CATALYSTS.map((c) => {
                  const x = cfg.news[c];
                  const type = catalystName(c, tn);
                  return (
                    <tr key={c}>
                      <td className="border-b border-border px-2 py-2">
                        <input
                          type="checkbox"
                          checked={x?.enabled === true}
                          disabled
                          readOnly
                          aria-label={tv("sheet.tradeType", { type })}
                          className="size-4 accent-accent"
                        />
                      </td>
                      <td className="border-b border-border px-2 py-2 text-ink">{type}</td>
                      <td className="border-b border-border px-2 py-2 text-ink-2">
                        {tn(`sides.${catalystSide(c)}`)}
                      </td>
                      <td className="border-b border-border px-2 py-2 text-ink-2 tabular-nums">
                        {hold(x?.maxHoldHours ?? NEWS_RULES.catalysts[c].maxHoldHours)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </fieldset>
    </>
  );
}

/** "Applying v{n}…": version mới đang chờ engine áp (trạng thái từ backend, quy tắc 1.6). */
export function ApplyingChip({ n }: { n: number }) {
  const t = useTranslations("signalAnalysis.research.mainnet.settings");
  return (
    <span
      role="status"
      className="rounded-full border border-warn-border bg-warn-bg px-2.5 py-0.5 text-xs font-extrabold text-warn"
    >
      {t("applying", { n })}
    </span>
  );
}

/** Lưu xong: câu "Saved as v{n}…" và, khi margin isolated không đủ cho cấu hình mới, cảnh báo như hộp Start (không chặn). */
function SavedNote({ result }: { result: NewsBotVersionResult }) {
  const t = useTranslations("signalAnalysis.research.mainnet.settings");
  const td = useTranslations("signalAnalysis.research.mainnet.dialogs.start.checks");
  const b = result.balance;
  return (
    <div className="flex flex-col gap-2">
      <p role="status" className="m-0 rounded-tile bg-pos-bg px-3.5 py-2.5 text-sm text-pos">
        {t("saved", { n: result.version })}
      </p>
      {b.ok ? null : (
        <p
          role="alert"
          className="m-0 rounded-tile border border-warn-border bg-warn-bg px-3.5 py-2.5 text-sm text-warn"
        >
          {b.available === null
            ? td("balanceNa", { needed: b.needed })
            : td("balance", { available: b.available, needed: b.needed })}
        </p>
      )}
    </div>
  );
}

function Markets({ cfg }: { cfg: NewsSignalConfig }) {
  const text = useMarketsText();
  const list = cfg.assets.markets;
  return (
    <>
      <span className="block">{text(cfg)}</span>
      {cfg.assets.mode === AssetMode.only && list.length > 0 ? (
        <span className="block text-xs font-semibold text-muted">{list.join(", ")}</span>
      ) : null}
    </>
  );
}

function Group({ legend, children }: { legend: string; children: ReactNode }) {
  return (
    <fieldset className="m-0 min-w-0 rounded-tile border border-border px-3.5 pt-2 pb-3.5">
      <legend className="px-1.5 text-[15px] font-extrabold text-ink">{legend}</legend>
      <dl className="m-0 grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-x-4.5 gap-y-2.5">
        {children}
      </dl>
    </fieldset>
  );
}

function Kv({
  label,
  mono = false,
  children,
}: {
  label: string;
  mono?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[12.5px] font-bold text-muted">{label}</dt>
      <dd className={`m-0 font-extrabold break-words text-ink ${mono ? "font-mono" : ""}`}>
        {children}
      </dd>
    </div>
  );
}
