"use client";

import {
  applyCommand,
  BotCommand,
  botDetailSchema,
  botListSchema,
  botSummarySchema,
  BotState,
  UserRole,
  type BotDetail,
} from "@drift/shared";
import { Button, ConfirmDialog, DataTable, Skeleton, StatusPill } from "@drift/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Pause, Plus, Square } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { NotConnected, useSodexMissing } from "@/components/not-connected";
import { PageHead } from "@/components/workspace";
import { WorkspaceShell } from "@/components/workspace-shell";
import { api } from "@/lib/api";
import { formatDateTime, formatDuration, formatMoney } from "@/lib/format";
import { useMarketNames } from "@/lib/markets";
import { useMe } from "@/lib/queries";

import { unitsOf } from "../preview";

import { useBotErrorText } from "./bot-errors";
import { BotProfit } from "./bot-profit";
import { BOTS_KEY, useStateLabel, waitingTooLong } from "./bots-page";
import { ConfigList, useConfigRows } from "./config-view";

// Trading Agent (SCREENS.md mục 8.3, artboard "Agent" / "Mobile-Agent"): trạng thái lấy từ backend; mỗi thao tác
// chỉ gửi lệnh rồi giữ trạng thái chuyển tiếp ("Pausing…") cho tới khi engine xác nhận (quy tắc 1.6). Bot `draft`
// chỉ nằm ở Strategy Lab (DEC-57): vào `/agent/:id` của draft thì chuyển sang màn Edit, archived thì về `/bots`.

type Action = "start" | "pause" | "resume" | "stop";
const TRANSITIONAL: readonly BotState[] = [
  BotState.starting,
  BotState.pausing,
  BotState.resuming,
  BotState.stopping,
];
const LIFECYCLE = ["stopped", "starting", "running", "paused", "stopping"] as const;
const clock = (v: string | number) => formatDateTime(v).split(", ").at(-1) ?? "";

export function AgentPage({ botId }: { botId?: string }) {
  const names = useMarketNames();
  const t = useTranslations("agent");
  const tm = useTranslations("common.missing");
  const tf = useTranslations("createBot");
  const tsh = useTranslations("common.shell");
  const tr = useTranslations("reasons");
  const router = useRouter();
  const qc = useQueryClient();
  const me = useMe();
  const list = useQuery({
    queryKey: BOTS_KEY,
    queryFn: () => api("GET", "/api/v1/bots", botListSchema),
    refetchInterval: 5_000,
  });
  const agents = (list.data?.items ?? []).filter(
    (b) => b.state !== BotState.draft && b.state !== BotState.archived,
  );
  const id = botId ?? agents[0]?.id;
  const detail = useQuery({
    queryKey: ["bot", id],
    queryFn: () => api("GET", `/api/v1/bots/${id ?? ""}`, botDetailSchema),
    enabled: id !== undefined,
    // Thăm dò nhanh hơn khi đang chờ backend xác nhận.
    refetchInterval: (q) =>
      q.state.data !== undefined && TRANSITIONAL.includes(q.state.data.bot.state) ? 1_000 : 5_000,
  });
  const stateLabel = useStateLabel();
  const errorText = useBotErrorText();
  const missing = useSodexMissing();
  const [dialog, setDialog] = useState<"start" | "stop" | null>(null);
  const [code, setCode] = useState("");
  const [sentAt, setSentAt] = useState<number | null>(null);
  const keys = useRef<Record<Action, string>>({
    start: crypto.randomUUID(),
    pause: crypto.randomUUID(),
    resume: crypto.randomUUID(),
    stop: crypto.randomUUID(),
  });

  const d: BotDetail | undefined = detail.data;
  const bot = d?.bot;
  // Draft → màn Edit; archived → Strategy Lab. Chỉ chuyển khi backend đã trả `state` (UI_REVIEW F1).
  useEffect(() => {
    if (bot === undefined) return;
    if (bot.state === BotState.draft) router.replace(`/bots/${bot.id}/edit`);
    else if (bot.state === BotState.archived) router.replace("/bots");
  }, [bot, router]);

  const act = useMutation({
    mutationFn: (action: Action) =>
      api("POST", `/api/v1/bots/${id ?? ""}/actions/${action}`, botSummarySchema, {
        idempotencyKey: keys.current[action],
        body:
          action === "start"
            ? { acknowledged: true, twoFactorCode: code }
            : action === "stop"
              ? { twoFactorCode: code }
              : {},
      }),
    onSuccess: async (_d, action) => {
      keys.current[action] = crypto.randomUUID();
      setSentAt(Date.now());
      setDialog(null);
      setCode("");
      await qc.invalidateQueries({ queryKey: ["bot", id] });
      await qc.invalidateQueries({ queryKey: BOTS_KEY });
    },
    onError: (_e, action) => {
      keys.current[action] = crypto.randomUUID();
    },
  });

  const can = (cmd: (typeof BotCommand)[keyof typeof BotCommand]) =>
    bot !== undefined && applyCommand(bot.state, cmd) !== null;
  const active = d?.versions.find((v) => v.status === "active");
  const configRows = useConfigRows(bot?.strategy ?? "", bot?.market ?? "", active?.config ?? {});
  const redirecting =
    bot !== undefined && (bot.state === BotState.draft || bot.state === BotState.archived);
  const loading = list.isPending || (id !== undefined && (detail.isPending || redirecting));
  const empty = !loading && id === undefined && list.isSuccess;

  const actions = (
    <>
      {can(BotCommand.pause) ? (
        <Button
          variant="secondary"
          className="w-full lg:w-auto"
          pending={act.isPending && act.variables === "pause"}
          onClick={() => {
            act.mutate("pause");
          }}
        >
          <Pause aria-hidden="true" size={16} />
          <span className="lg:hidden">{t("pauseHint")}</span>
          <span className="hidden lg:inline">{t("pause")}</span>
        </Button>
      ) : null}
      {can(BotCommand.resume) ? (
        <Button
          className="w-full lg:w-auto"
          pending={act.isPending && act.variables === "resume"}
          onClick={() => {
            act.mutate("resume");
          }}
        >
          {t("resume")}
        </Button>
      ) : null}
      {can(BotCommand.start) ? (
        <Button
          className="w-full lg:w-auto"
          onClick={() => {
            setDialog("start");
          }}
        >
          {t("start")}
        </Button>
      ) : null}
    </>
  );

  const hero = (dd: BotDetail) => {
    const b = dd.bot;
    const transitional = TRANSITIONAL.includes(b.state);
    const time = clock(sentAt ?? b.updatedAt);
    const sub =
      b.state === BotState.running
        ? t("confirmed", { time })
        : b.state === BotState.paused
          ? t("stateSub.paused", { time })
          : b.state === BotState.stopped
            ? t("stateSub.stopped", { time, n: dd.openOrders })
            : b.state === BotState.stopping
              ? t("stateSub.stopping", { time, n: dd.openOrders })
              : t("sent", { time });
    const lastError = dd.events.find((e) => e.type === "error");
    // Runtime = từ sự kiện "Running" gần nhất tới giờ, chỉ khi đang chạy (dữ liệu thật, không ước tính).
    const runningSince =
      b.state === BotState.running
        ? dd.events.find((e) => e.type === "state" && e.decision === "Running")?.occurredAt
        : undefined;
    const runtime =
      runningSince === undefined ? null : formatDuration(Date.now() - Date.parse(runningSince));
    const quote = names.asset(unitsOf(b.market)?.quote ?? "");
    const lastEvent = dd.events[0];
    const cur =
      b.state === BotState.pausing
        ? "paused"
        : b.state === BotState.resuming
          ? "running"
          : (b.state as string);
    const tile = (label: string, value: ReactNode) => (
      <div className="flex min-w-0 flex-col gap-1 rounded-[14px] bg-surface/85 px-3.5 py-3">
        <dt className="text-xs font-semibold text-muted">{label}</dt>
        <dd className="m-0 text-base font-extrabold whitespace-nowrap tabular-nums">{value}</dd>
      </div>
    );
    return (
      <section
        aria-labelledby="agent-title"
        className="relative flex flex-col gap-4 overflow-hidden rounded-hero bg-hero p-5 lg:px-7 lg:py-6"
      >
        <svg
          aria-hidden="true"
          width="300"
          height="300"
          viewBox="0 0 300 300"
          fill="none"
          className="pointer-events-none absolute -top-28 -right-24 opacity-60"
        >
          <circle cx="150" cy="150" r="70" className="stroke-surface" strokeWidth="1.5" />
          <circle cx="150" cy="150" r="115" className="stroke-surface" strokeWidth="1.5" />
        </svg>
        <div className="relative flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3.5">
            <span
              aria-hidden="true"
              className="flex size-12 flex-none items-center justify-center rounded-[16px] bg-accent text-white lg:size-14"
            >
              <Bot size={26} />
            </span>
            <div className="flex min-w-0 flex-col gap-1">
              <h2 id="agent-title" className="m-0 truncate text-xl font-extrabold">
                {b.name}
              </h2>
              <span className="text-[13px] text-ink-2">
                {names.market(b.market)} · {tf(`strategies.${b.strategy}.name`)}
              </span>
              <div
                role="status"
                aria-live="polite"
                aria-label={t("statusLabel")}
                className="flex flex-wrap items-center gap-2"
              >
                <StatusPill {...stateLabel(b)} />
                <span className="text-xs text-ink-2 tabular-nums">{sub}</span>
              </div>
              {waitingTooLong(b) ? (
                <span className="text-xs font-semibold text-warn">
                  {tsh("waitingLong", { time: clock(b.updatedAt) })}
                  {lastError?.why == null ? null : ` · ${lastError.why}`}
                </span>
              ) : null}
            </div>
          </div>
          <div className="flex w-full flex-col gap-2 lg:w-auto lg:flex-row">{actions}</div>
        </div>

        {/* Thanh vòng đời (artboard Agent): bước hiện tại tô đậm; đang chờ backend thì viền nét đứt. */}
        <ol
          aria-label={t("lifecycle.label")}
          className="relative m-0 hidden list-none flex-wrap items-center gap-1 p-0 lg:flex"
        >
          {LIFECYCLE.map((k, i) => (
            <li key={k} className="flex items-center gap-1">
              <span
                aria-current={k === cur ? "step" : undefined}
                className={`inline-flex h-[30px] items-center rounded-full px-3 text-[13px] font-bold ${
                  k === cur
                    ? transitional
                      ? "border-[1.5px] border-dashed border-warn-bar bg-warn-bg text-warn"
                      : "bg-ink text-surface"
                    : "text-muted"
                }`}
              >
                {t(`lifecycle.${k}`)}
              </span>
              {i === LIFECYCLE.length - 1 ? null : (
                <span aria-hidden="true" className="text-muted">
                  →
                </span>
              )}
            </li>
          ))}
        </ol>

        <dl className="relative m-0 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
          {tile(t("profit"), <BotProfit bot={b} />)}
          {tile(t("runtime"), runtime ?? tm("notAvailable"))}
          {tile(t("openOrders"), dd.openOrders)}
          {tile(
            t("lastDecision"),
            lastEvent === undefined ? tm("notAvailable") : clock(lastEvent.occurredAt),
          )}
        </dl>
        {b.capital === null ? null : (
          <span className="relative text-xs text-ink-2 tabular-nums">
            {t("investment")}: {formatMoney(b.capital)} {quote}
          </span>
        )}
      </section>
    );
  };

  return (
    <WorkspaceShell current="agent" isTeam={me.data?.role === UserRole.team}>
      <div className="flex flex-col gap-5">
        <PageHead
          title={t("title")}
          subtitle={t("subtitle")}
          back={{ href: "/", label: t("back") }}
          action={
            <Link
              href="/bots?tab=catalog"
              className="flex min-h-tap items-center gap-2 rounded-[14px] bg-accent px-[18px] text-sm font-bold text-white no-underline shadow-accent"
            >
              <Plus aria-hidden="true" size={16} strokeWidth={2.4} />
              {t("newAgent")}
            </Link>
          }
        />

        {missing ? <NotConnected /> : null}

        {/* Chọn agent: hàng thẻ ngang phía trên (artboard Agent), chi tiết chiếm hết chiều ngang (F1). */}
        {agents.length > 1 || (agents.length === 1 && botId !== undefined) ? (
          <nav aria-label={t("agentsLabel")} className="flex gap-2.5 overflow-x-auto pb-1">
            {agents.map((a) => (
              <Link
                key={a.id}
                href={`/agent/${a.id}`}
                aria-current={a.id === id ? "page" : undefined}
                title={a.reasonCode === null ? undefined : tr(a.reasonCode)}
                className={`flex min-w-[220px] flex-none items-center gap-2.5 rounded-[16px] border px-3.5 py-2.5 no-underline ${a.id === id ? "border-accent bg-accent-tint" : "border-border bg-surface"}`}
              >
                <span
                  aria-hidden="true"
                  className="flex size-8 flex-none items-center justify-center rounded-full bg-accent-tint text-xs font-extrabold text-accent-ink"
                >
                  {a.name.slice(0, 1).toUpperCase()}
                </span>
                <span className="flex min-w-0 flex-col">
                  <strong className="truncate text-sm text-ink">{a.name}</strong>
                  <span className="truncate text-xs text-muted">{names.market(a.market)}</span>
                </span>
                <span className="ml-auto">
                  {/* Thẻ chọn agent chỉ hiện trạng thái; lý do pause/stop nằm ở phần chi tiết bên dưới. */}
                  <StatusPill {...stateLabel({ ...a, reasonCode: null })} />
                </span>
              </Link>
            ))}
          </nav>
        ) : null}

        {loading ? (
          <div className="flex flex-col gap-5">
            <Skeleton className="h-64 w-full rounded-hero" />
            <Skeleton className="h-48 w-full rounded-card" />
          </div>
        ) : null}

        {/* Không có agent nào để xem: một thẻ empty lớn (E6). Không render cùng lúc với chi tiết bot (F1). */}
        {empty ? (
          <section className="flex flex-col items-center gap-4 rounded-card border border-border bg-surface px-6 py-12 text-center">
            <span
              aria-hidden="true"
              className="flex size-16 items-center justify-center rounded-[20px] bg-accent text-white shadow-accent"
            >
              <Bot size={30} />
            </span>
            <h2 className="m-0 text-xl font-extrabold">{t("noneTitle")}</h2>
            <p className="m-0 max-w-md text-sm text-ink-2">{t("none")}</p>
            <Link
              href="/bots?tab=catalog"
              className="flex min-h-tap items-center gap-2 rounded-[14px] bg-accent px-[18px] text-sm font-bold text-white no-underline shadow-accent"
            >
              <Plus aria-hidden="true" size={16} strokeWidth={2.4} />
              {t("newAgent")}
            </Link>
          </section>
        ) : null}

        {loading || bot === undefined || d === undefined ? null : (
          <div className="flex min-w-0 flex-col gap-5">
            {hero(d)}
            {act.error === null || dialog !== null ? null : (
              <p role="alert" className="m-0 text-sm text-neg-ink">
                {errorText(act.error)}
              </p>
            )}

            {d.volumeMaker === null ? null : <VolumeMakerCard vm={d.volumeMaker} />}

            <section
              aria-labelledby="decisions-title"
              className="flex min-w-0 flex-col gap-3 rounded-card border border-border bg-surface p-5"
            >
              <div className="flex items-center justify-between gap-3">
                <h2 id="decisions-title" className="m-0 text-lg font-extrabold">
                  <span className="lg:hidden">{t("recentDecisions")}</span>
                  <span className="hidden lg:inline">{t("decisions")}</span>
                </h2>
                <Link
                  href={`/orders?botId=${bot.id}`}
                  className="flex-none text-[13px] font-bold whitespace-nowrap text-accent-ink"
                >
                  {t("allOrders")}
                </Link>
              </div>
              <div className="hidden lg:block">
                <DataTable
                  caption={t("decisions")}
                  label={t("decisions")}
                  status={d.events.length === 0 ? "empty" : "ready"}
                  empty={{ title: t("noDecisions") }}
                  error={{ title: "" }}
                  rows={d.events}
                  getRowKey={(e) => e.id}
                  columns={[
                    {
                      key: "time",
                      header: t("cols.time"),
                      cell: (e) => formatDateTime(e.occurredAt),
                    },
                    {
                      key: "decision",
                      header: t("cols.decision"),
                      cell: (e) => <strong>{e.decision ?? e.type}</strong>,
                    },
                    { key: "why", header: t("cols.why"), cell: (e) => e.why ?? "" },
                    {
                      key: "result",
                      header: t("cols.result"),
                      cell: (e) => (e.result === null ? "" : <ResultPill text={e.result} />),
                    },
                  ]}
                />
              </div>
              {/* Mobile: danh sách giờ · hành động đậm · kết quả (artboard Mobile-Agent), không dùng bảng. */}
              <ul className="m-0 flex list-none flex-col p-0 lg:hidden">
                {d.events.length === 0 ? (
                  <li className="py-3 text-sm text-ink-2">{t("noDecisions")}</li>
                ) : (
                  d.events.slice(0, 10).map((e) => (
                    <li
                      key={e.id}
                      className="flex gap-3 border-b border-border py-2.5 tabular-nums last:border-b-0"
                    >
                      <span className="w-14 flex-none text-xs text-muted">
                        {clock(e.occurredAt).slice(0, 5)}
                      </span>
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <strong className="text-sm">{e.decision ?? e.type}</strong>
                        <span className="text-xs text-ink-2">{e.result ?? e.why ?? ""}</span>
                      </span>
                    </li>
                  ))
                )}
              </ul>
            </section>

            {active === undefined ? null : (
              <section
                aria-labelledby="config-title"
                className="flex flex-col gap-3.5 rounded-card border border-border bg-surface p-5"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 id="config-title" className="m-0 text-lg font-extrabold">
                    {t("config")}
                  </h2>
                  <span className="text-sm text-muted">
                    {t("configVersion", {
                      version: active.version,
                      date: formatDateTime(active.appliedAt ?? active.createdAt),
                    })}
                  </span>
                </div>
                <ConfigList rows={configRows} />
                <Link
                  href={`/bots/${bot.id}/edit`}
                  className="flex min-h-tap items-center justify-center rounded-control bg-accent-tint text-sm font-bold text-accent-ink no-underline"
                >
                  {t("editBot")}
                </Link>
                <p className="m-0 text-xs text-muted">
                  {t("editHint", { next: active.version + 1, version: active.version })}
                </p>
              </section>
            )}

            <section
              aria-labelledby="errors-title"
              className="flex flex-col gap-3 rounded-card border border-border bg-surface p-5"
            >
              <h2 id="errors-title" className="m-0 text-lg font-extrabold">
                {t("recentErrors")}
              </h2>
              {d.events.filter((e) => e.type === "error").length === 0 ? (
                <p className="m-0 text-sm text-ink-2">{t("noErrors")}</p>
              ) : (
                <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
                  {d.events
                    .filter((e) => e.type === "error")
                    .slice(0, 5)
                    .map((e) => (
                      <li
                        key={e.id}
                        className="flex flex-col gap-1 rounded-[16px] border border-neg-border bg-neg-soft px-4 py-3 text-neg-text"
                      >
                        <span className="flex flex-wrap items-baseline justify-between gap-2">
                          <strong>{e.decision ?? e.type}</strong>
                          <span className="text-xs tabular-nums">
                            {formatDateTime(e.occurredAt)}
                          </span>
                        </span>
                        {e.why === null ? null : <span className="text-[13px]">{e.why}</span>}
                      </li>
                    ))}
                </ul>
              )}
            </section>

            {can(BotCommand.stop) ? (
              <section
                aria-labelledby="stop-title"
                className="flex flex-wrap items-center justify-between gap-4 rounded-card border border-neg-border bg-neg-soft p-5"
              >
                <div className="flex min-w-0 flex-[1_1_280px] flex-col gap-1">
                  <h2 id="stop-title" className="m-0 text-lg font-extrabold text-neg-text">
                    {t("stopTitle")}
                  </h2>
                  <p className="m-0 text-sm text-neg-text">{t("stopBody")}</p>
                </div>
                <div className="flex w-full flex-col gap-2 lg:w-auto">
                  <button
                    type="button"
                    className="flex min-h-[52px] items-center justify-center gap-2 rounded-[16px] border-[1.5px] border-neg bg-surface px-5 text-[15px] font-extrabold text-neg-ink"
                    onClick={() => {
                      setDialog("stop");
                    }}
                  >
                    <Square aria-hidden="true" size={16} />
                    {t("stop")}
                  </button>
                  <span className="text-center text-xs text-muted lg:hidden">{t("stopHint")}</span>
                </div>
              </section>
            ) : null}

            <ConfirmDialog
              open={dialog !== null}
              onOpenChange={(open) => {
                if (!open) setDialog(null);
              }}
              title={
                dialog === "stop"
                  ? t("stopDialog.title", { name: bot.name })
                  : t("startDialog.title", { name: bot.name })
              }
              consequencesLabel={t("consequences")}
              consequences={
                dialog === "stop"
                  ? [t("stopDialog.stay"), t("stopDialog.noNew"), t("env")]
                  : [t("startDialog.limits"), t("env")]
              }
              confirmLabel={
                dialog === "stop"
                  ? t("stopDialog.cta", { count: d.openOrders })
                  : t("startDialog.cta")
              }
              cancelLabel={dialog === "stop" ? t("stopDialog.cancel") : t("startDialog.cancel")}
              tone={dialog === "stop" ? "danger" : "primary"}
              twoFactor={{
                label: t("twoFactor"),
                value: code,
                onChange: setCode,
                ...(act.error === null ? {} : { error: errorText(act.error) }),
              }}
              pending={act.isPending}
              onConfirm={() => {
                if (dialog !== null) act.mutate(dialog);
              }}
            />
          </div>
        )}
      </div>
    </WorkspaceShell>
  );
}

/** Kết quả của một quyết định: pill màu theo loại (artboard Agent). */
function ResultPill({ text }: { text: string }) {
  const lower = text.toLowerCase();
  const tone = lower.includes("unknown")
    ? "bg-unknown-bg text-unknown"
    : lower.includes("filled") || lower.includes("confirmed")
      ? "bg-pos-bg text-pos"
      : lower.includes("open")
        ? "bg-accent-tint text-accent-ink"
        : "bg-surface-2 text-ink-2";
  return <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${tone}`}>{text}</span>;
}

function VolumeMakerCard({ vm }: { vm: NonNullable<BotDetail["volumeMaker"]> }) {
  const t = useTranslations("agent");
  const tm = useTranslations("common.missing");
  return (
    <section
      aria-labelledby="vm-title"
      className="flex flex-col gap-3 rounded-card border border-border bg-surface p-5"
    >
      <h2 id="vm-title" className="m-0 text-lg font-extrabold">
        {t("vm.title")}
      </h2>
      <dl className="m-0 grid grid-cols-2 gap-3 text-sm tabular-nums sm:grid-cols-3">
        <div>
          <dt className="text-xs text-muted">{t("vm.volume")}</dt>
          <dd className="m-0 font-bold">
            {vm.volume}{" "}
            <span className="font-normal text-muted">
              {t("vm.ofTarget", { target: vm.volumeTarget })}
            </span>
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted">{t("vm.cost")}</dt>
          <dd className="m-0 font-bold">
            {vm.cost}{" "}
            <span className="font-normal text-muted">
              {t("vm.ofBudget", { budget: vm.costBudget })}
            </span>
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted">{t("vm.perMillion")}</dt>
          <dd className="m-0 font-bold">{vm.costPerMillion ?? tm("notAvailable")}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">{t("vm.makerShare")}</dt>
          <dd className="m-0 font-bold">
            {vm.makerSharePct === null ? tm("notAvailable") : `${vm.makerSharePct}%`}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted">{t("vm.inventory")}</dt>
          <dd className="m-0 font-bold">{vm.inventory}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">{t("vm.selfTrade")}</dt>
          <dd className="m-0 font-bold">{vm.selfTradeBlocked}</dd>
        </div>
      </dl>
    </section>
  );
}
