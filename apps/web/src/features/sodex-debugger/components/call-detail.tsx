"use client";

import type { SodexCallDetail, SodexCallItem } from "@drift/shared";
import { Button, Skeleton } from "@drift/ui";
import { ChevronDown, ChevronUp, Copy, X } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { ApiError } from "@/lib/api";

import { useSodexCall } from "../api";
import {
  formatMs,
  localTime,
  maskAddress,
  maskAddressesIn,
  prettyJson,
  methodLabel,
  utcDateTime,
  utcTime,
} from "../format";

import { JsonView, Kv, OutcomeTag, Path, RedactChip } from "./bits";

// Panel chi tiết một lời gọi (mockup view=detail): cố định bên phải ở desktop, toàn màn hình ở điện thoại.

type Tab = "request" | "response" | "context";
const TABS: Tab[] = ["request", "response", "context"];
const TAB_KEY = { request: "tabRequest", response: "tabResponse", context: "tabContext" } as const;

const iconBtn =
  "inline-flex size-9 flex-none cursor-pointer items-center justify-center rounded-control border border-border-input bg-surface text-ink";

function copy(text: string, onDone: () => void) {
  void navigator.clipboard.writeText(text).then(onDone, () => undefined);
}

export function CallDetail({
  id,
  item,
  myTime,
  onClose,
  onPrev,
  onNext,
  onOpenCall,
  onReport,
}: {
  id: string;
  /** Dòng trong danh sách (hiện ngay tiêu đề trong lúc chờ chi tiết). */
  item: SodexCallItem | undefined;
  myTime: boolean;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  onOpenCall: (id: string) => void;
  onReport: () => void;
}) {
  const t = useTranslations("sodexDebugger.detail");
  const q = useSodexCall(id);
  const [tab, setTab] = useState<Tab>("request");
  const [status, setStatus] = useState("");
  const tabRefs = useRef(new Map<Tab, HTMLButtonElement>());
  const d = q.data;
  const head = d ?? item;

  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = TABS.indexOf(tab);
    const next =
      e.key === "ArrowRight"
        ? TABS[(i + 1) % TABS.length]
        : e.key === "ArrowLeft"
          ? TABS[(i + TABS.length - 1) % TABS.length]
          : e.key === "Home"
            ? TABS[0]
            : e.key === "End"
              ? TABS[TABS.length - 1]
              : undefined;
    if (next === undefined) return;
    e.preventDefault();
    setTab(next);
    tabRefs.current.get(next)?.focus();
  };
  const copied = () => {
    setStatus(t("copied"));
  };

  return (
    <section
      id="sodex-call-detail"
      aria-labelledby="sodex-call-detail-h"
      className="z-40 flex flex-col overflow-hidden bg-surface max-md:-mx-4 max-md:-mt-3 md:fixed md:top-5 md:right-5 md:bottom-5 md:w-[560px] md:max-w-[calc(100vw-40px)] md:rounded-card md:border md:border-border md:shadow-card"
    >
      <div className="flex flex-col gap-2.5 border-b border-border px-[18px] pt-4 pb-3 max-md:px-4 max-md:py-3">
        <button
          type="button"
          onClick={onClose}
          className="inline-flex min-h-tap cursor-pointer self-start border-0 bg-transparent p-0 text-[13px] font-bold text-accent-ink md:hidden"
        >
          {t("back")}
        </button>
        <div className="flex items-start gap-2.5">
          <h2
            id="sodex-call-detail-h"
            className="m-0 flex-1 font-mono text-base font-extrabold [overflow-wrap:anywhere] max-md:text-sm"
          >
            {head === undefined ? null : (
              <>
                {methodLabel(head)} <Path path={head.endpoint} />
              </>
            )}
          </h2>
          <button type="button" aria-label={t("prev")} className={iconBtn} onClick={onPrev}>
            <ChevronUp aria-hidden="true" size={16} strokeWidth={2.2} />
          </button>
          <button type="button" aria-label={t("next")} className={iconBtn} onClick={onNext}>
            <ChevronDown aria-hidden="true" size={16} strokeWidth={2.2} />
          </button>
          <button
            type="button"
            aria-label={t("close")}
            className={`${iconBtn} max-md:hidden`}
            onClick={onClose}
          >
            <X aria-hidden="true" size={16} strokeWidth={2.2} />
          </button>
        </div>
        {head === undefined ? null : (
          <div className="flex flex-wrap items-center gap-2">
            <OutcomeTag outcome={head.outcome} />
            <span className="text-[12.5px] leading-normal text-ink-2">
              {myTime
                ? t("metaLocal", {
                    at: utcDateTime(head.at),
                    local: localTime(head.at),
                    latency: formatMs(head.latencyMs),
                    service: head.service,
                    kind: head.kind === "ws" ? t("kindWs") : t("kindRest"),
                  })
                : t("meta", {
                    at: utcDateTime(head.at),
                    latency: formatMs(head.latencyMs),
                    service: head.service,
                    kind: head.kind === "ws" ? t("kindWs") : t("kindRest"),
                  })}
            </span>
          </div>
        )}
        {d?.outcome === "unreadable" && d.unreadableReason !== null ? (
          <div className="rounded-[14px] bg-unknown-bg px-3 py-2.5 text-[13px] leading-normal text-unknown">
            <b className="mb-0.5 block">{t("why")}</b>
            <span className="text-ink">{unreadableText(d, t)}</span>
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button className="max-md:hidden" disabled={d === undefined} onClick={onReport}>
            <Copy aria-hidden="true" size={16} />
            {t("copyReport")}
          </Button>
          <Button
            variant="secondary"
            disabled={d === undefined}
            onClick={() => {
              if (d !== undefined) copy(JSON.stringify(d, null, 2), copied);
            }}
          >
            {t("copyJson")}
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              copy(
                `${window.location.origin}/admin/sodex-debugger?call=${encodeURIComponent(id)}`,
                copied,
              );
            }}
          >
            {t("copyLink")}
          </Button>
        </div>
        <div role="status" className="sr-only">
          {status}
        </div>
      </div>
      <div
        role="tablist"
        aria-label={t("tabs")}
        className="flex gap-1 border-b border-border px-[18px] max-md:px-2"
      >
        {TABS.map((k) => (
          <button
            key={k}
            ref={(el) => {
              if (el === null) tabRefs.current.delete(k);
              else tabRefs.current.set(k, el);
            }}
            type="button"
            role="tab"
            id={`sodex-tab-${k}`}
            aria-controls={`sodex-panel-${k}`}
            aria-selected={tab === k}
            tabIndex={tab === k ? 0 : -1}
            onKeyDown={onTabKey}
            onClick={() => {
              setTab(k);
            }}
            className={`-mb-px min-h-tap cursor-pointer border-0 border-b-[3px] bg-transparent px-3 text-sm font-bold max-md:flex-1 ${tab === k ? "border-accent text-ink" : "border-transparent text-muted"}`}
          >
            {t(TAB_KEY[k])}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`sodex-panel-${tab}`}
        aria-labelledby={`sodex-tab-${tab}`}
        className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-auto px-[18px] pt-3.5 pb-[18px] max-md:px-4 max-md:pb-24"
      >
        {q.isPending ? (
          <div aria-busy="true" className="flex flex-col gap-3">
            <span className="sr-only">{t("loading")}</span>
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : q.isError ? (
          <div role="alert" className="flex flex-col items-start gap-3">
            <p className="m-0 font-bold">
              {q.error instanceof ApiError && q.error.status === 404 ? t("notFound") : t("error")}
            </p>
            <Button
              variant="secondary"
              onClick={() => {
                void q.refetch();
              }}
            >
              {t("retry")}
            </Button>
          </div>
        ) : tab === "request" ? (
          <RequestTab d={q.data} onCopied={copied} />
        ) : tab === "response" ? (
          <ResponseTab d={q.data} />
        ) : (
          <ContextTab d={q.data} onOpenCall={onOpenCall} />
        )}
      </div>
      <div className="fixed inset-x-0 bottom-0 z-10 flex bg-surface px-4 pt-3 pb-[calc(12px+env(safe-area-inset-bottom))] shadow-float md:hidden">
        <Button className="flex-1" disabled={d === undefined} onClick={onReport}>
          <Copy aria-hidden="true" size={16} />
          {t("copyReport")}
        </Button>
      </div>
    </section>
  );
}

type T = ReturnType<typeof useTranslations<"sodexDebugger.detail">>;

function unreadableText(d: SodexCallDetail, t: T): string {
  switch (d.unreadableReason) {
    case "order_result_without_cl_ord_id":
      // Câu về cách xử lý tiếp chỉ đúng với lệnh của engine (PM chốt, review PR #217 M5).
      return d.service === "engine" ? t("unreadable.noClOrdIdEngine") : t("unreadable.noClOrdId");
    case "invalid_json":
      return t("unreadable.invalidJson");
    case "schema_mismatch":
      return t("unreadable.schemaMismatch");
    case "http_error":
      return t("unreadable.httpError", { status: d.httpStatus ?? "" });
    case null:
      return "";
  }
}

function Sect({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <div>
      <h3 className="m-0 mb-1.5 flex flex-wrap items-center gap-2 text-xs font-extrabold tracking-[.03em] text-muted uppercase">
        {title}
      </h3>
      {children}
    </div>
  );
}

function Fold({
  title,
  extra,
  sub,
  open = true,
  children,
}: {
  title: string;
  extra?: ReactNode;
  sub?: string;
  open?: boolean;
  children: ReactNode;
}) {
  return (
    <details open={open} className="group">
      <summary className="flex min-h-9 cursor-pointer list-none items-center gap-2 text-xs font-extrabold tracking-[.03em] text-muted uppercase [&::-webkit-details-marker]:hidden">
        <span
          aria-hidden="true"
          className="size-2 -rotate-45 border-r-2 border-b-2 border-muted transition-transform group-open:rotate-45"
        />
        {title}
        {extra}
        {sub === undefined ? null : (
          <span className="ml-auto text-[13px] font-semibold tracking-normal normal-case">
            {sub}
          </span>
        )}
      </summary>
      {children}
    </details>
  );
}

function RequestTab({ d, onCopied }: { d: SodexCallDetail; onCopied: () => void }) {
  const t = useTranslations("sodexDebugger.detail");
  const none = <span className="font-sans text-muted">{t("none")}</span>;
  let query: string[] = [];
  if (d.url !== null) {
    try {
      query = [...new URL(d.url).searchParams.entries()].map(([k, v]) => `${k}=${v}`);
    } catch {
      query = [];
    }
  }
  return (
    <>
      <Sect title={t("url")}>
        <Kv
          rows={[
            { k: t("method"), v: methodLabel(d) },
            {
              k: t("url"),
              v:
                d.url === null ? (
                  none
                ) : (
                  <span className="flex w-full items-start gap-2">
                    <span className="min-w-0 flex-1">{maskAddressesIn(d.url)}</span>
                    <button
                      type="button"
                      aria-label={t("copyUrl")}
                      className="inline-flex size-8 flex-none cursor-pointer items-center justify-center rounded-control border border-border-input bg-surface text-ink"
                      onClick={() => {
                        if (d.url !== null) copy(d.url, onCopied);
                      }}
                    >
                      <Copy aria-hidden="true" size={14} />
                    </button>
                  </span>
                ),
            },
            {
              k: t("queryParams"),
              v: query.length === 0 ? none : maskAddressesIn(query.join("&")),
            },
          ]}
        />
      </Sect>
      <Sect title={t("headers")}>
        {d.requestHeaders.length === 0 ? (
          <p className="m-0 text-[13px] text-muted">{t("none")}</p>
        ) : (
          <Kv
            rows={d.requestHeaders.map((h) => ({
              k: h.name,
              v:
                h.redaction === "signature" ? (
                  <RedactChip kind="signature" />
                ) : h.redaction === "masked" ? (
                  <>
                    {h.value}
                    <RedactChip kind="masked" />
                  </>
                ) : (
                  h.value
                ),
            }))}
          />
        )}
      </Sect>
      <Fold
        title={t("body")}
        extra={d.signed ? <RedactChip kind="signature" /> : undefined}
        {...(d.requestBodyBytes === null ? {} : { sub: t("bytes", { n: d.requestBodyBytes }) })}
      >
        {d.signed && d.actionType !== null ? (
          <p className="m-0 mb-1.5 text-[13px] leading-[1.45] text-muted">
            {t.rich("actionParams", {
              action: d.actionType,
              code: (c) => <span className="font-mono">{c}</span>,
            })}
          </p>
        ) : null}
        {d.requestBody === null ? (
          <p className="m-0 text-[13px] text-muted">{t("noBody")}</p>
        ) : (
          <JsonView text={prettyJson(maskAddressesIn(d.requestBody))} label={t("requestBody")} />
        )}
      </Fold>
    </>
  );
}

function ResponseTab({ d }: { d: SodexCallDetail }) {
  const t = useTranslations("sodexDebugger.detail");
  const na = <span className="font-sans text-muted">{t("notAvailable")}</span>;
  const code =
    d.envelopeCode !== null && d.orderCodes.length > 0
      ? t("envelopeOrder", { envelope: d.envelopeCode, order: d.orderCodes.join(", ") })
      : d.sodexCode !== null
        ? String(d.sodexCode)
        : d.envelopeCode !== null
          ? String(d.envelopeCode)
          : null;
  const rows: { k: string; v: ReactNode; mono?: boolean }[] = [
    { k: t("http"), v: d.httpStatus === null ? na : String(d.httpStatus) },
    { k: t("sodexCode"), v: code ?? na },
  ];
  if (d.sodexSays !== null)
    rows.push({ k: t("sodexError"), v: <span className="text-neg-ink">{d.sodexSays}</span> });
  rows.push({ k: t("latency"), v: formatMs(d.latencyMs) });
  return (
    <>
      <Sect title={t("status")}>
        <Kv rows={rows} />
      </Sect>
      <Fold
        title={t("body")}
        {...(d.responseBodyBytes === null ? {} : { sub: t("bytes", { n: d.responseBodyBytes }) })}
      >
        {d.responseBody === null ? (
          <p className="m-0 text-[13px] text-muted">{t("noBody")}</p>
        ) : (
          <>
            <JsonView
              text={prettyJson(maskAddressesIn(d.responseBody))}
              label={t("responseBody")}
              errMatch={d.sodexSays}
            />
            {d.responseTruncated ? (
              <p className="m-0 mt-1.5 text-[13px] text-muted">
                {t("truncated", { n: d.responseBody.length })}
              </p>
            ) : null}
          </>
        )}
      </Fold>
      <Fold title={t("responseHeaders")} sub={String(d.responseHeaders.length)} open={false}>
        {d.responseHeaders.length === 0 ? (
          <p className="m-0 text-[13px] text-muted">{t("none")}</p>
        ) : (
          <Kv rows={d.responseHeaders.map((h) => ({ k: h.name, v: h.value }))} />
        )}
      </Fold>
    </>
  );
}

function ContextTab({ d, onOpenCall }: { d: SodexCallDetail; onOpenCall: (id: string) => void }) {
  const t = useTranslations("sodexDebugger.detail");
  const tc = useTranslations("createBot");
  const na = <span className="font-sans text-muted">{t("notAvailable")}</span>;
  const strategy = (s: string) => (tc.has(`strategies.${s}.name`) ? tc(`strategies.${s}.name`) : s);
  const account =
    d.accountAddress === null ? (
      na
    ) : (
      <>
        {d.accountUserId === null ? (
          maskAddress(d.accountAddress)
        ) : (
          <Link href={`/admin/users/${d.accountUserId}`}>{maskAddress(d.accountAddress)}</Link>
        )}
        {d.sodexAccountId === null ? null : ` · ${t("accountId", { id: d.sodexAccountId })}`}
      </>
    );
  return (
    <>
      <Sect title={t("whereFrom")}>
        <Kv
          rows={[
            { k: t("service"), v: d.service },
            { k: t("traceId"), v: d.traceId ?? na },
            {
              k: t("bot"),
              mono: false,
              v:
                d.botDetail === null ? (
                  d.bot === null ? (
                    na
                  ) : (
                    <Link href={`/agent/${d.bot.id}`}>{d.bot.name}</Link>
                  )
                ) : (
                  <span>
                    <Link href={`/agent/${d.botDetail.id}`}>{d.botDetail.name}</Link>
                    {` · ${strategy(d.botDetail.strategy)} · ${d.botDetail.market}`}
                  </span>
                ),
            },
            { k: t("account"), v: account },
            { k: t("clOrdId"), v: d.clOrdIds.length === 0 ? na : d.clOrdIds.join(", ") },
            { k: t("orderId"), v: d.orderIds.length === 0 ? na : d.orderIds.join(", ") },
            {
              k: t("connId"),
              v:
                d.wsConn === null ? (
                  na
                ) : (
                  <>
                    {d.wsConn.connId}
                    <span className="font-sans text-[13px] text-muted">
                      {d.wsConn.open ? t("connOpen") : t("connClosed")}
                    </span>
                  </>
                ),
            },
          ]}
        />
      </Sect>
      <Sect title={t("related")}>
        {d.related.length === 0 ? (
          <p className="m-0 text-[13px] text-muted">{t("relatedNone")}</p>
        ) : (
          <>
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
              {d.related.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onOpenCall(r.id);
                    }}
                    className="grid min-h-tap w-full cursor-pointer grid-cols-[auto_1fr_auto] items-center gap-2.5 rounded-control border border-border bg-surface px-2.5 py-2 text-left text-[12.5px] text-ink"
                  >
                    <span className="font-mono">{utcTime(r.at)}</span>
                    <span className="min-w-0 font-mono break-all">
                      {methodLabel(r)} {r.endpoint}
                      {r.clOrdIds.length === 0 ? "" : ` · ${r.clOrdIds.join(", ")}`}
                    </span>
                    <OutcomeTag outcome={r.outcome} />
                  </button>
                </li>
              ))}
            </ul>
            <p className="m-0 mt-1.5 text-[13px] text-muted">{t("relatedNote")}</p>
          </>
        )}
      </Sect>
    </>
  );
}
