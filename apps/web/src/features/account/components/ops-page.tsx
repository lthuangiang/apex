"use client";

import { teamOpsViewSchema, type TeamOpsBot, type TeamOpsView } from "@drift/shared";
import { Button, cx, Skeleton } from "@drift/ui";
import { useQuery } from "@tanstack/react-query";
import { Info, TriangleAlert } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";

import { Card, PageHead, Workspace } from "@/components/workspace";
import { api, ApiError } from "@/lib/api";
import { BELOW_LG, useMediaQuery } from "@/lib/use-media";

import { clockWithZone, compactUsd, usd } from "../ops-format";

import { BotsPanel, HealthChip, useReasonText, type Strat } from "./ops-bots";

// Trang Bot Monitor của team (tên cũ "Ops"; docs/mockups/ops, DEC-TBD-ops-redesign, thay bố cục DEC-276). Chỉ đọc.
// Bộ lọc Show: Active (mặc định) hoặc All bots (phân trang 50, tìm kiếm), giữ trên URL `?show=all&tab=vb&q=&page=`.
// Làm mới tay hoặc tự động 30 s (không nhanh hơn); 403 thì ngừng làm mới; làm mới lỗi thì giữ dữ liệu cũ và ghi rõ là
// cũ. Số không có → "Not available", không bao giờ 0. Giờ theo múi giờ của trình duyệt.

type Show = "active" | "all";

const forbiddenError = (e: unknown) => e instanceof ApiError && e.code === "FORBIDDEN";
const STALE_RED_MS = 5 * 60_000;
export const ROUTE = "/admin/bot-monitor";

/** Khoá cache của một lượt xem (dùng chung với test). */
export const opsQueryKey = (show: Show, tab: Strat, q: string, page: number) =>
  [
    "team-ops",
    show,
    show === "all" ? tab : null,
    show === "all" ? q : "",
    show === "all" ? page : 1,
  ] as const;

export function OpsPage() {
  const t = useTranslations("teamOps");
  const params = useSearchParams();
  const router = useRouter();
  const isMobile = useMediaQuery(BELOW_LG);
  const [show, setShow] = useState<Show>(params.get("show") === "all" ? "all" : "active");
  const [tab, setTab] = useState<Strat>(
    params.get("tab") === "vb" ? "volume_farm" : "volume_maker",
  );
  const [search, setSearch] = useState(params.get("q") ?? "");
  const [query, setQuery] = useState(params.get("q") ?? "");
  const [page, setPage] = useState(Math.max(1, Number(params.get("page")) || 1));

  const sync = (next: { show: Show; tab: Strat; q: string; page: number }) => {
    const p = new URLSearchParams();
    if (next.show === "all") p.set("show", "all");
    if (next.tab === "volume_farm") p.set("tab", "vb");
    if (next.show === "all" && next.q !== "") p.set("q", next.q);
    if (next.show === "all" && next.page > 1) p.set("page", String(next.page));
    const s = p.toString();
    router.replace(s === "" ? ROUTE : `${ROUTE}?${s}`, { scroll: false });
  };
  const state = { show, tab, q: query, page };
  const change = (patch: Partial<typeof state>) => {
    const next = { ...state, ...patch };
    setShow(next.show);
    setTab(next.tab);
    setQuery(next.q);
    setPage(next.page);
    sync(next);
  };

  const q = useQuery({
    queryKey: opsQueryKey(show, tab, query, page),
    queryFn: () => {
      const p = new URLSearchParams();
      if (show === "all") {
        p.set("show", "all");
        p.set("strategy", tab);
        p.set("page", String(page));
        if (query !== "") p.set("q", query);
      }
      const s = p.toString();
      return api(
        "GET",
        s === "" ? "/api/v1/admin/ops" : `/api/v1/admin/ops?${s}`,
        teamOpsViewSchema,
      );
    },
    refetchInterval: (x) => (forbiddenError(x.state.error) ? false : 30_000),
    retry: (n, e) => !forbiddenError(e) && n < 2,
  });
  const forbidden = forbiddenError(q.error);
  const v = q.data;
  const stale = q.isError && v !== undefined;

  return (
    <Workspace current="ops">
      <div className="flex flex-col gap-5">
        <PageHead
          title={t("title")}
          subtitle={
            isMobile ? (
              t("purposeMobile")
            ) : (
              <span className="flex flex-col gap-1">
                <span>{t("purpose")}</span>
                <span className="text-xs text-muted">{t("readOnly")}</span>
              </span>
            )
          }
          action={
            forbidden ? undefined : (
              <span className="flex flex-wrap items-center gap-3">
                {v === undefined ? null : (
                  <span className="text-xs text-ink-2">
                    {t(isMobile ? "checkedMobile" : "checked", {
                      time: clockWithZone(v.checkedAt),
                    })}
                  </span>
                )}
                <Button
                  variant="secondary"
                  pending={q.isFetching}
                  onClick={() => {
                    void q.refetch();
                  }}
                >
                  {t("refresh")}
                </Button>
              </span>
            )
          }
        />
        {forbidden ? (
          <Card>
            <p className="m-0">{t("forbidden")}</p>
          </Card>
        ) : (
          <>
            {stale ? <StaleBar checkedAt={v.checkedAt} failedAt={q.errorUpdatedAt} /> : null}
            {v === undefined && q.isError ? (
              <LoadError
                onRetry={() => {
                  void q.refetch();
                }}
              />
            ) : (
              <>
                <Summary v={v} isMobile={isMobile} />
                {v?.show === "active" && v.bots.length === 0 ? (
                  <Empty />
                ) : (
                  <>
                    {v === undefined ? null : <Attention rows={v.attention} isMobile={isMobile} />}
                    <HowToRead isMobile={isMobile} />
                    <BotsPanel
                      v={v}
                      tab={tab}
                      show={show}
                      isMobile={isMobile}
                      onTab={(x) => {
                        change({ tab: x, page: 1 });
                      }}
                      filter={
                        <ShowFilter
                          show={show}
                          search={search}
                          onSearch={setSearch}
                          onShow={(x) => {
                            change({ show: x, page: 1 });
                          }}
                          onSubmit={() => {
                            change({ q: search.trim(), page: 1 });
                          }}
                        />
                      }
                      pager={
                        v?.page === null || v?.page === undefined ? null : (
                          <Pager
                            page={v.page.page}
                            pages={Math.max(1, Math.ceil(v.page.total / v.page.pageSize))}
                            onPage={(p) => {
                              change({ page: p });
                            }}
                          />
                        )
                      }
                    />
                  </>
                )}
                {v === undefined ? (
                  <span className="sr-only" role="status">
                    {t("loading")}
                  </span>
                ) : null}
              </>
            )}
          </>
        )}
        <footer className="text-sm text-ink-2">{t("footer")}</footer>
      </div>
    </Workspace>
  );
}

function StaleBar({ checkedAt, failedAt }: { checkedAt: string; failedAt: number }) {
  const t = useTranslations("teamOps");
  const [now] = useState(() => Date.now());
  const age = Math.max(0, now - Date.parse(checkedAt));
  const old = age > STALE_RED_MS;
  return (
    <div
      role="status"
      className={cx(
        "flex items-start gap-2 rounded-card border px-4 py-3 text-sm font-semibold",
        old
          ? "border-neg-border bg-neg-bg text-neg-text"
          : "border-warn-border bg-warn-bg text-warn",
      )}
    >
      <TriangleAlert aria-hidden="true" size={18} className="mt-0.5 shrink-0" />
      <span className="flex flex-col gap-0.5">
        <span>
          {t("stale", {
            failed: clockWithZone(new Date(failedAt || now).toISOString()),
            checked: clockWithZone(checkedAt),
            minutes: Math.floor(age / 60_000),
          })}
        </span>
        {old ? <span>{t("staleOld")}</span> : null}
      </span>
    </div>
  );
}

function LoadError({ onRetry }: { onRetry: () => void }) {
  const t = useTranslations("teamOps");
  return (
    <div
      role="alert"
      className="flex flex-col items-start gap-2 rounded-card border border-neg-border bg-surface p-5"
    >
      <strong>{t("errorTitle")}</strong>
      <span className="text-sm text-ink-2">{t("errorBody")}</span>
      <Button variant="secondary" onClick={onRetry}>
        {t("tryAgain")}
      </Button>
    </div>
  );
}

function Empty() {
  const t = useTranslations("teamOps");
  return (
    <Card>
      <div className="flex flex-col items-center gap-1.5 py-6 text-center">
        <strong>{t("emptyTitle")}</strong>
        <span className="max-w-[460px] text-sm text-ink-2">{t("emptyBody")}</span>
      </div>
    </Card>
  );
}

const TILE_KEYS = ["bots", "volumeHour", "volumeDay", "cost", "alerts", "attention"] as const;
type TileKey = (typeof TILE_KEYS)[number];

function Summary({ v, isMobile }: { v: TeamOpsView | undefined; isMobile: boolean }) {
  const t = useTranslations("teamOps");
  const [open, setOpen] = useState<TileKey | null>(null);
  const na = t("notAvailable");
  const s = v?.summary;
  const split = (mm: string | null, vb: string | null) =>
    t(isMobile ? "summary.splitMobile" : "summary.split", {
      mm: compactUsd(mm) ?? na,
      vb: compactUsd(vb) ?? na,
    });
  const tile = (
    k: TileKey,
  ): { label: string; value: string; sub: string; tone?: "bad" | "check" } => {
    if (s === undefined) return { label: label(k), value: "", sub: "" };
    const tot = s.total;
    switch (k) {
      case "bots":
        return {
          label: label(k),
          value: t("summary.botsValue", { count: tot.running }),
          sub: t(isMobile ? "summary.botsSubMobile" : "summary.botsSub", {
            paused: tot.paused,
            stopping: tot.stopping,
            stopped: tot.stoppedDay,
          }),
        };
      case "volumeHour":
        return {
          label: label(k),
          value: compactUsd(tot.volumeHour) ?? na,
          sub: split(s.volume_maker.volumeHour, s.volume_farm.volumeHour),
        };
      case "volumeDay":
        return {
          label: label(k),
          value: compactUsd(tot.volumeDay) ?? na,
          sub: split(s.volume_maker.volumeDay, s.volume_farm.volumeDay),
        };
      case "cost":
        return {
          label: label(k),
          value: usd(tot.costPerMillion) ?? na,
          sub: t(isMobile ? "summary.splitMobile" : "summary.split", {
            mm: usd(s.volume_maker.costPerMillion) ?? na,
            vb: usd(s.volume_farm.costPerMillion) ?? na,
          }),
        };
      case "alerts":
        return {
          label: label(k),
          value: t("summary.botCount", { count: s.alertBots }),
          sub: s.alerts
            .slice(0, 3)
            .map((a) =>
              isMobile
                ? a.invariant
                : t("summary.alertOn", { invariant: a.invariant, name: a.name }),
            )
            .join(" · "),
          ...(s.alertBots > 0 ? { tone: "bad" as const } : {}),
        };
      case "attention":
        return {
          label: label(k),
          value: t("summary.botCount", { count: s.problem + s.check }),
          sub: t("summary.attentionSub", { problem: s.problem, check: s.check }),
          ...(s.problem + s.check > 0 ? { tone: "check" as const } : {}),
        };
    }
  };
  function label(k: TileKey): string {
    if (isMobile && (k === "volumeHour" || k === "volumeDay"))
      return t(`summary.${k}Mobile` as "summary.volumeHourMobile");
    return t(`summary.${k}`);
  }
  return (
    <section aria-labelledby="ops-summary" className="flex flex-col gap-2.5">
      <h2 id="ops-summary" className={cx("m-0 text-base font-extrabold", isMobile && "sr-only")}>
        {t("summary.title")}
      </h2>
      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-3 xl:grid-cols-6">
        {TILE_KEYS.map((k) => {
          const x = tile(k);
          const isOpen = open === k;
          const tipId = `ops-tip-${k}`;
          return (
            <div
              key={k}
              className={cx(
                "flex flex-col gap-1 rounded-card border bg-surface p-3.5",
                x.tone === "bad"
                  ? "border-neg-border"
                  : x.tone === "check"
                    ? "border-warn-border"
                    : "border-border",
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <span className="text-xs font-bold text-ink-2">{x.label}</span>
                {isMobile ? null : (
                  <button
                    type="button"
                    aria-label={t("summary.howCounted", { label: x.label.toLowerCase() })}
                    aria-expanded={isOpen}
                    aria-controls={isOpen ? tipId : undefined}
                    onClick={() => {
                      setOpen(isOpen ? null : k);
                    }}
                    className="-m-1 inline-flex size-8 cursor-pointer items-center justify-center rounded-control border-0 bg-transparent text-muted"
                  >
                    <Info aria-hidden="true" size={16} />
                  </button>
                )}
              </div>
              {s === undefined ? (
                <Skeleton className="h-7 w-24" />
              ) : (
                <span className="text-2xl font-extrabold tabular-nums">{x.value}</span>
              )}
              {s === undefined ? (
                <Skeleton className="h-3.5 w-32" />
              ) : x.sub === "" ? null : (
                <span className="text-xs text-ink-2">{x.sub}</span>
              )}
              {isOpen ? (
                <span id={tipId} className="text-xs text-ink-2">
                  {t(`summary.tips.${k}`)}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Attention({ rows, isMobile }: { rows: TeamOpsBot[]; isMobile: boolean }) {
  const t = useTranslations("teamOps");
  const reason = useReasonText();
  return (
    <section
      aria-labelledby="ops-attn"
      className="flex flex-col gap-2.5 rounded-card border border-border bg-surface p-4"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id="ops-attn" className="m-0 text-base font-extrabold">
          {t("attention.title")}
        </h2>
        {isMobile ? null : <span className="text-xs text-ink-2">{t("attention.note")}</span>}
      </div>
      {rows.length === 0 ? (
        <p className="m-0 text-sm text-ink-2">{t("attention.empty")}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {rows.map((r) => (
            <li
              key={r.botId}
              className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1 rounded-control bg-surface-2 px-3 py-2 text-sm lg:grid-cols-[120px_180px_200px_1fr]"
            >
              <HealthChip health={r.health} />
              <span className="font-bold">{r.name}</span>
              {isMobile ? null : (
                <span className="text-xs text-ink-2">
                  {t(`tabs.${r.strategy}`)} · {r.market}
                </span>
              )}
              <span className="col-span-2 text-ink-2 lg:col-span-1">
                {r.reasons[0] === undefined ? "" : reason(r.reasons[0], r)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const LEGEND = ["problem", "check", "healthy", "not_running", "archived"] as const;
const TERMS = ["bp", "cost", "maker", "gap", "cut", "untracked", "round", "invariant"] as const;

function HowToRead({ isMobile }: { isMobile: boolean }) {
  const t = useTranslations("teamOps");
  return (
    <details
      open={!isMobile}
      className="rounded-card border border-border bg-surface p-4 [&_summary]:cursor-pointer"
    >
      <summary className="min-h-11 content-center text-sm font-extrabold">{t("how.title")}</summary>
      <div className="mt-3 grid gap-5 lg:grid-cols-2">
        <div className="flex flex-col gap-2.5 text-sm">
          <p className="m-0">{t("how.intro")}</p>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {LEGEND.map((h) => (
              <li key={h} className="grid grid-cols-[120px_1fr] items-start gap-3">
                <HealthChip health={h} />
                <span>{t(`how.rules.${h}`)}</span>
              </li>
            ))}
          </ul>
          <p className="m-0 text-xs text-ink-2">{t("how.note")}</p>
        </div>
        <div className="flex flex-col gap-2 text-sm">
          <strong>{t("how.words")}</strong>
          <dl className="m-0 flex flex-col gap-1.5">
            {TERMS.map((k) => (
              <div key={k}>
                <dt className="inline font-bold">{t(`how.terms.${k}`)}</dt>
                <dd className="m-0 inline">: {t(`how.glossary.${k}`)}</dd>
              </div>
            ))}
          </dl>
          {isMobile ? (
            <dl className="m-0 mt-2 flex flex-col gap-1.5">
              {TILE_KEYS.map((k) => (
                <div key={k}>
                  <dt className="inline font-bold">{t(`summary.${k}`)}</dt>
                  <dd className="m-0 inline">: {t(`summary.tips.${k}`)}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </div>
      </div>
    </details>
  );
}

function ShowFilter({
  show,
  search,
  onShow,
  onSearch,
  onSubmit,
}: {
  show: Show;
  search: string;
  onShow: (s: Show) => void;
  onSearch: (s: string) => void;
  onSubmit: () => void;
}) {
  const t = useTranslations("teamOps.show");
  const searchId = useId();
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div role="group" aria-label={t("label")} className="flex items-center gap-2">
        <span className="text-xs font-bold text-ink-2" aria-hidden="true">
          {t("label")}
        </span>
        <span className="inline-flex rounded-control bg-surface-2 p-1">
          {(["active", "all"] as const).map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={show === s}
              onClick={() => {
                onShow(s);
              }}
              className={cx(
                "min-h-11 cursor-pointer rounded-[9px] border-0 px-3.5 text-sm font-bold text-ink",
                show === s ? "bg-surface shadow-sm" : "bg-transparent",
              )}
            >
              {t(s)}
            </button>
          ))}
        </span>
      </div>
      {show === "all" ? (
        <form
          role="search"
          className="flex flex-col gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit();
          }}
        >
          <label htmlFor={searchId} className="text-xs font-bold text-ink-2">
            {t("search")}
          </label>
          <input
            id={searchId}
            type="search"
            value={search}
            placeholder={t("searchPlaceholder")}
            onChange={(e) => {
              onSearch(e.target.value);
            }}
            className="min-h-11 min-w-64 rounded-control border border-border-input bg-surface px-3 text-sm text-ink"
          />
        </form>
      ) : null}
    </div>
  );
}

function Pager({
  page,
  pages,
  onPage,
}: {
  page: number;
  pages: number;
  onPage: (p: number) => void;
}) {
  const t = useTranslations("teamOps.show");
  return (
    <nav aria-label={t("pageOf", { page, pages })} className="flex items-center gap-3">
      <Button
        variant="secondary"
        disabled={page <= 1}
        onClick={() => {
          onPage(page - 1);
        }}
      >
        {t("previous")}
      </Button>
      <span className="text-sm text-ink-2">{t("pageOf", { page, pages })}</span>
      <Button
        variant="secondary"
        disabled={page >= pages}
        onClick={() => {
          onPage(page + 1);
        }}
      >
        {t("next")}
      </Button>
    </nav>
  );
}
