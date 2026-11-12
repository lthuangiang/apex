"use client";

import type { AdminUserDetail, PlatformStats } from "@drift/shared";
import { useTranslations } from "next-intl";

import { Card } from "@/components/workspace";
import { formatDateTime, formatInteger } from "@/lib/format";

// Nhật ký màn Connect SoDEX (DEC-114) cho team: từng lần thử của một user, và phễu toàn nền tảng.

const FUNNEL = [
  "view",
  "picker_opened",
  "wallet_picked",
  "wallet_connected",
  "key_requested",
  "sign_prompted",
  "signed",
  "fee_requested",
  "connected",
] as const;
const FAILED = new Set(["wallet_failed", "request_failed", "sign_rejected", "sodex_failed"]);

type Event = AdminUserDetail["connect"]["events"][number];

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** Một dòng chi tiết ngắn cho từng bước: ví, lý do, mã lỗi. */
function detail(e: Event): string {
  const d = e.data;
  const parts = [
    str(d.name) ?? str(d.wallet),
    str(d.which),
    str(d.address),
    str(d.reason),
    str(d.code),
    str(d.message),
  ].filter((x): x is string => x !== null);
  return [...new Set(parts)].join(" · ");
}

function useStepLabel() {
  const t = useTranslations("connectLog.steps");
  return (type: string) => (t.has(type) ? t(type) : type);
}

export function ConnectAttempts({
  connect,
  tz,
}: {
  connect: AdminUserDetail["connect"];
  tz: string | undefined;
}) {
  const t = useTranslations("connectLog");
  const label = useStepLabel();
  // Events mới nhất trước: gom theo attempt, giữ thứ tự attempt mới nhất trước, bước trong attempt theo thời gian.
  const groups = new Map<string, Event[]>();
  for (const e of connect.events) groups.set(e.attemptId, [...(groups.get(e.attemptId) ?? []), e]);
  const attempts = [...groups.values()].map((evs) => [...evs].reverse());

  return (
    <Card>
      <h2 className="m-0 text-lg font-extrabold">{t("title")}</h2>
      <p className="m-0 text-xs text-muted">{t("hint")}</p>
      {attempts.length === 0 ? (
        <p className="m-0 text-sm text-ink-2">{t("none")}</p>
      ) : (
        <ol className="m-0 flex list-none flex-col gap-3 p-0">
          {attempts.slice(0, 10).map((evs) => {
            const view = evs.find((e) => e.type === "view")?.data ?? {};
            const device = [str(view.device), str(view.os), str(view.browser)]
              .filter((x): x is string => x !== null)
              .join(" · ");
            const shown = [
              ...list(view.walletsDetected),
              ...(view.browserWallet === true ? [t("browserWallet")] : []),
              ...(view.walletConnect === true ? ["WalletConnect"] : []),
            ];
            const last = evs[evs.length - 1];
            const first = evs[0];
            if (first === undefined || last === undefined) return null;
            return (
              <li
                key={first.attemptId}
                className="flex flex-col gap-2 rounded-tile bg-surface-2 p-3.5"
              >
                <div className="flex flex-wrap justify-between gap-2 text-sm">
                  <strong>{formatDateTime(first.at, tz)}</strong>
                  <span className="font-semibold">
                    {t("lastStep")}: {label(last.type)}
                  </span>
                </div>
                <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                  <dt className="text-ink-2">{t("device")}</dt>
                  <dd className="m-0">{device === "" ? t("unknown") : device}</dd>
                  <dt className="text-ink-2">{t("options")}</dt>
                  <dd className="m-0">{shown.length === 0 ? t("noOptions") : shown.join(", ")}</dd>
                  {list(view.notDetected).length === 0 ? null : (
                    <>
                      <dt className="text-ink-2">{t("notDetected")}</dt>
                      <dd className="m-0">{list(view.notDetected).join(", ")}</dd>
                    </>
                  )}
                  {list(view.ethereumFlags).length === 0 ? null : (
                    <>
                      <dt className="text-ink-2">{t("flags")}</dt>
                      <dd className="m-0 font-mono">{list(view.ethereumFlags).join(", ")}</dd>
                    </>
                  )}
                </dl>
                <ol className="m-0 flex list-none flex-col gap-1 p-0 text-xs">
                  {evs.map((e, i) => (
                    <li key={`${e.at}-${String(i)}`} className="flex flex-wrap gap-2">
                      <span className="tabular-nums text-muted">
                        {new Date(e.at).toLocaleTimeString("en-GB", {
                          timeZone: tz ?? "Asia/Ho_Chi_Minh",
                        })}
                      </span>
                      <span className={`font-bold ${FAILED.has(e.type) ? "text-neg-ink" : ""}`}>
                        {label(e.type)}
                      </span>
                      {e.type === "view" ? null : (
                        <span className="break-all text-ink-2">{detail(e)}</span>
                      )}
                    </li>
                  ))}
                </ol>
              </li>
            );
          })}
        </ol>
      )}
      {connect.requests.length === 0 ? null : (
        <>
          <h3 className="m-0 text-base font-extrabold">{t("requests")}</h3>
          <ul className="m-0 flex list-none flex-col gap-1 p-0 text-xs">
            {connect.requests.map((r, i) => (
              <li key={`${r.at}-${String(i)}`} className="flex flex-wrap gap-2">
                <span className="tabular-nums text-muted">{formatDateTime(r.at, tz)}</span>
                <span className="font-bold">{r.action}</span>
                <span className={r.status === "failed" ? "text-neg-ink" : ""}>{r.status}</span>
                {r.sodexError === null ? null : (
                  <span className="break-all text-ink-2">{r.sodexError}</span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

export function ConnectFunnel({ connect }: { connect: PlatformStats["connect"] }) {
  const t = useTranslations("connectLog");
  const label = useStepLabel();
  const users = new Map(connect.steps.map((s) => [s.type, s.users]));
  const base = users.get("view") ?? 0;
  const total = connect.devices.reduce((n, d) => n + d.users, 0);

  return (
    <Card title={t("funnel")}>
      <p className="m-0 text-xs text-muted">{t("funnelHint")}</p>
      {base === 0 ? (
        <p className="m-0 text-sm text-ink-2">{t("noData")}</p>
      ) : (
        <>
          <ol className="m-0 flex list-none flex-col gap-1.5 p-0">
            {FUNNEL.map((type) => {
              const n = users.get(type) ?? 0;
              const pct = Math.round((n / base) * 100);
              return (
                <li
                  key={type}
                  className="grid grid-cols-[10rem_1fr_5.5rem] items-center gap-2 text-sm"
                >
                  <span className="text-ink-2">{label(type)}</span>
                  <span className="h-2.5 overflow-hidden rounded-full bg-surface-2">
                    <span
                      className="block h-full rounded-full bg-accent"
                      style={{ width: `${String(pct)}%` }}
                    />
                  </span>
                  <span className="text-right font-semibold tabular-nums">
                    {formatInteger(n)} · {pct}%
                  </span>
                </li>
              );
            })}
          </ol>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <h3 className="m-0 text-base font-extrabold">{t("failures")}</h3>
              {connect.failures.length === 0 ? (
                <p className="m-0 text-sm text-ink-2">{t("noFailures")}</p>
              ) : (
                <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm">
                  {connect.failures.map((f) => (
                    <li key={`${f.type}-${f.reason}`} className="flex justify-between gap-2">
                      <span className="min-w-0 break-all">
                        <strong className="text-neg-ink">{label(f.type)}</strong> · {f.reason}
                      </span>
                      <span className="tabular-nums">{formatInteger(f.users)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <h3 className="m-0 text-base font-extrabold">{t("devices")}</h3>
              <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm">
                {connect.devices.map((d) => (
                  <li key={d.device} className="flex justify-between gap-2">
                    <span>{d.device}</span>
                    <span className="tabular-nums">
                      {formatInteger(d.users)}
                      {total > 0 ? ` · ${String(Math.round((d.users / total) * 100))}%` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </>
      )}
    </Card>
  );
}
