"use client";

import { add, type LotteryJob } from "@drift/shared";
import { BottomSheet, Button } from "@drift/ui";
import { Check, Gift, Wallet } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { WalletPicker } from "@/features/onboarding/components/wallet-picker";
import { shortAddress } from "@/lib/format";

import { setActionState, type Flow, type Pick } from "../action-store";
import { formatCount, formatTokenAmount, formatUsd, levelDotClass } from "../format";
import { SODEX_BLIND_BOX_URL } from "../links";
import {
  useCybereatorProfile,
  useRewardsBoxes,
  useRewardsJob,
  type RewardsSession,
} from "../queries";
import { useActionState, useBoxActions } from "../use-box-actions";

import { Banner } from "./rewards-states";
import { Spinner } from "./sign-in-hero";

// Popup Claim / Open / Merge (bản phác 07, 15–18; demo chuyển động). Desktop là dialog giữa màn, mobile là bottom sheet
// (`BottomSheet`, Radix giữ focus và trả focus). Bước tiến trình theo `job.status` (submitting → pending → revealed), không
// có thanh phần trăm; hiệu ứng hé lộ chỉ chạy khi SoDEX đã trả kết quả.

type Auth = RewardsSession;

const ACTIVE = (j: LotteryJob | undefined) =>
  j === undefined || j.status === "submitting" || j.status === "pending";
/** Sau ngần này vẫn chưa xong: "Taking longer than usual." */
const SLOW_MS = 30_000;
/** Quá ngần này box thì phần còn lại hiện cùng lúc (demo). */
const FLIP_MAX = 8;

export function Level({ level }: { level: string | null | undefined }) {
  if (level === null || level === undefined || level === "") return null;
  return (
    <span className="inline-flex items-center gap-1.5 font-extrabold">
      <span
        aria-hidden="true"
        className={`size-3 flex-none rounded-[4px] ${levelDotClass(level)}`}
      />
      {level}
    </span>
  );
}

/** Danh sách token ID: ≤ 5 hiện đủ; nhiều hơn thì 4 + "and {n} more" + Show all / Show less. */
export function IdList({ ids }: { ids: readonly number[] }) {
  const t = useTranslations("rewards.action.ids");
  const [all, setAll] = useState(false);
  const long = ids.length > 5;
  const shown = long && !all ? ids.slice(0, 4) : ids;
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-sm tabular-nums">
      {shown.map((id) => (
        <span key={id} className="rounded-[8px] bg-surface-2 px-2 py-1 font-semibold">
          #{id}
        </span>
      ))}
      {long && !all ? <span className="text-ink-2">{t("more", { n: ids.length - 4 })}</span> : null}
      {long ? (
        <button
          type="button"
          aria-expanded={all}
          onClick={() => {
            setAll(!all);
          }}
          className="min-h-tap px-1 text-xs font-bold text-accent-ink"
        >
          {all ? t("showLess") : t("showAll")}
        </button>
      ) : null}
    </div>
  );
}

function Stepper({ steps, at }: { steps: readonly string[]; at: number }) {
  return (
    <ol className="m-0 flex list-none flex-col gap-2 p-0 text-sm">
      {steps.map((s, i) => {
        const done = i < at;
        const act = i === at;
        return (
          <li
            key={s}
            aria-current={act ? "step" : undefined}
            className={`flex items-center gap-2.5 ${act ? "font-bold text-ink" : done ? "text-ink" : "text-ink-2"}`}
          >
            <span
              aria-hidden="true"
              className={`flex size-5 flex-none items-center justify-center rounded-full border-2 ${done ? "border-pos-dot bg-pos-dot text-white" : act ? "border-accent motion-safe:animate-[rw-breathe_1.4s_ease-in-out_infinite]" : "border-border-input"}`}
            >
              {done ? <Check size={12} strokeWidth={3} /> : null}
            </span>
            {s}
          </li>
        );
      })}
    </ol>
  );
}

function Buttons({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap gap-2.5 pt-1">{children}</div>;
}

const ANIM_IN =
  "motion-safe:animate-[rw-in_180ms_ease-out] motion-reduce:animate-[rw-fade_150ms_linear]";

/** Popup + theo dõi job khi popup đóng. Gắn một lần ở thẻ Overview và ở trang /rewards. */
export function ActionHost({ auth }: { auth: Auth }) {
  const state = useActionState();
  const actions = useBoxActions(auth);
  const flow = state.flow;
  const jobId = flow?.step === "job" ? flow.jobId : null;
  const job = useRewardsJob(auth, jobId);

  // Job xong khi popup đang đóng: dải "xong" ở dòng job / thẻ.
  const status = job.data?.status;
  useEffect(() => {
    if (flow?.step !== "job" || state.open || status !== "revealed") return;
    setActionState({
      done: { jobId: flow.jobId, pick: flow },
    });
  }, [flow, state.open, status]);

  if (flow === null) return null;
  return <Popup open={state.open} flow={flow} job={job.data} auth={auth} actions={actions} />;
}

function titleOf(
  flow: Flow,
  job: LotteryJob | undefined,
  t: ReturnType<typeof useTranslations<"rewards.action">>,
  tj: ReturnType<typeof useTranslations<"rewards.card.job">>,
): string {
  const n = flow.count;
  const level = flow.level ?? "";
  if (flow.step === "error" || (flow.step === "job" && job?.status === "failed"))
    return t(`${flow.kind}.failed`);
  if (flow.step === "job" && job?.status === "revealed") {
    if (flow.kind === "claim") return t("claim.result", { n: job.minted?.length ?? n });
    if (flow.kind === "merge") return t("merge.result");
    return t("open.result", { n: job.boxes?.length ?? n });
  }
  if (
    flow.step === "job" ||
    flow.step === "sending" ||
    flow.step === "checking" ||
    flow.step === "unsure"
  )
    // Job khôi phục không có số box: câu không số của dòng job.
    return n > 0
      ? t(`${flow.kind}.processing`, { n })
      : tj(
          flow.kind === "claim" ? "claimingAny" : flow.kind === "merge" ? "merging" : "openingAny",
        );
  if (flow.kind === "claim") return t("claim.title", { n });
  return t(`${flow.kind}.title`, { n, level });
}

function Popup({
  open,
  flow,
  job,
  auth,
  actions,
}: {
  open: boolean;
  flow: Flow;
  job: LotteryJob | undefined;
  auth: Auth;
  actions: ReturnType<typeof useBoxActions>;
}) {
  const t = useTranslations("rewards.action");
  const tj = useTranslations("rewards.card.job");
  return (
    <BottomSheet
      open={open}
      onOpenChange={(o) => {
        if (!o) actions.close();
      }}
      title={titleOf(flow, job, t, tj)}
      closeLabel={t("close")}
    >
      <div className={`flex flex-col gap-3 ${ANIM_IN}`}>
        <Body flow={flow} job={job} auth={auth} actions={actions} />
      </div>
    </BottomSheet>
  );
}

function Body({
  flow,
  job,
  auth,
  actions,
}: {
  flow: Flow;
  job: LotteryJob | undefined;
  auth: Auth;
  actions: ReturnType<typeof useBoxActions>;
}) {
  const t = useTranslations("rewards.action");
  const tr = useTranslations("rewards");
  const level = flow.level ?? "";
  const cancel = (
    <Button variant="secondary" onClick={actions.close}>
      {t("cancel")}
    </Button>
  );
  const closeBtn = (
    <Button variant="secondary" onClick={actions.close}>
      {t("close")}
    </Button>
  );

  switch (flow.step) {
    case "confirm":
      return (
        <>
          {flow.kind === "claim" ? (
            <>
              <BoxStack n={Math.min(3, flow.count)} />
              <p className="m-0 text-sm text-ink-2">{t("claim.body")}</p>
            </>
          ) : (
            <>
              <p className="m-0 text-sm text-ink-2">{t("oldest", { level })}</p>
              <IdList ids={flow.tokenIds} />
              {flow.kind === "open" ? (
                <>
                  <p className="m-0 text-sm text-ink-2">{t("open.body")}</p>
                  <p className="m-0 text-xs text-ink-2">{t("open.inside")}</p>
                </>
              ) : (
                <>
                  <p className="m-0 text-sm text-ink-2">{t("merge.body", { n: flow.count })}</p>
                  <p className="m-0 text-xs text-ink-2">{t("merge.sign")}</p>
                </>
              )}
            </>
          )}
          <Buttons>
            <Button onClick={() => void actions.confirm()}>
              {flow.kind === "claim"
                ? t("claim.n", { n: flow.count })
                : flow.kind === "open"
                  ? t("open.confirm")
                  : t("merge.confirm")}
            </Button>
            {cancel}
          </Buttons>
        </>
      );
    case "picker":
      return (
        <>
          <WalletPicker onPick={(c) => void actions.pickWallet(c)} />
          <Buttons>{cancel}</Buttons>
        </>
      );
    case "wallet":
      return (
        <>
          <div
            role="status"
            className="flex flex-col items-center gap-2 rounded-tile bg-surface-2 px-4 py-5 text-center"
          >
            <span
              aria-hidden="true"
              className="flex size-14 items-center justify-center rounded-[18px] bg-accent text-white ring-8 ring-accent-tint motion-safe:animate-[rw-breathe_1.6s_ease-in-out_infinite]"
            >
              <Wallet size={26} />
            </span>
            <b>{t("wallet.title")}</b>
            <span className="text-sm text-ink-2">{t("wallet.body")}</span>
          </div>
          <Buttons>{cancel}</Buttons>
        </>
      );
    case "sending":
      return (
        <>
          <Stepper steps={stepsOf(flow.kind, t)} at={flow.kind === "claim" ? 0 : 1} />
          <p className="m-0 text-xs text-ink-2">{t("canClose")}</p>
          <Buttons>{closeBtn}</Buttons>
        </>
      );
    case "checking":
    case "unsure":
      return (
        <>
          <div
            role="status"
            className="flex flex-col gap-0.5 rounded-tile bg-unknown-bg px-4 py-3 text-sm text-unknown"
          >
            <b>{t("unsure.title", { kind: flow.kind })}</b>
            <span>{t("unsure.body")}</span>
          </div>
          {flow.step === "checking" ? (
            <span className="flex items-center gap-2 text-sm text-ink-2">
              <Spinner />
              {t("unsure.checking")}
            </span>
          ) : (
            <p className="m-0 text-sm text-ink-2">{t("unsure.notFound")}</p>
          )}
          <Buttons>{closeBtn}</Buttons>
        </>
      );
    case "error":
      return (
        <>
          {flow.reason === "wallet" && flow.connected !== undefined && auth.master !== null ? (
            <Banner
              tone="warn"
              alert
              title={tr("mismatch.title")}
              body={`${tr("mismatch.connected")} ${shortAddress(flow.connected)} · ${tr("mismatch.account")} ${shortAddress(auth.master)}. ${tr("mismatch.switch", { address: shortAddress(auth.master) })}`}
            />
          ) : flow.reason === "expired" ? (
            <Banner tone="warn" alert title={tr("expired.title")} body={tr("expired.body")} />
          ) : flow.reason === "busy" ? (
            <Banner tone="err" alert title={tr("errors.busyNoTime")} body={tr("errors.busyBody")} />
          ) : (
            <ErrorBanner said={flow.said} />
          )}
          {flow.reason === "rejected" || flow.reason === "failed" ? (
            <FailedBody flow={flow} />
          ) : null}
          <Buttons>
            {flow.reason === "rejected" && flow.kind !== "claim" ? (
              <Button onClick={() => void actions.retry()}>{t("tryAgain")}</Button>
            ) : null}
            {closeBtn}
          </Buttons>
        </>
      );
    case "job":
      return <JobBody flow={flow} job={job} auth={auth} actions={actions} closeBtn={closeBtn} />;
  }
}

function ErrorBanner({ said }: { said: string | null }) {
  const tr = useTranslations("rewards.errors");
  return (
    <div
      role="alert"
      className="rounded-tile bg-neg-bg px-4 py-3 text-sm font-bold text-neg-ink motion-safe:animate-[rw-shake_260ms]"
    >
      {said === null ? tr("business") : `${tr("said")} “${said}”`}
    </div>
  );
}

function FailedBody({ flow }: { flow: Pick }) {
  const t = useTranslations("rewards.action");
  return (
    <p className="m-0 text-sm text-ink-2">
      {flow.kind === "claim"
        ? t("claim.failedBody")
        : flow.kind === "open"
          ? t("open.failedBody")
          : t("merge.failedBody", { n: flow.count })}
    </p>
  );
}

function stepsOf(kind: Pick["kind"], t: ReturnType<typeof useTranslations<"rewards.action">>) {
  if (kind === "claim") return [t("steps.sent"), t("steps.minting"), t("steps.ready")];
  return [
    t("steps.signed"),
    t("steps.sent"),
    t("steps.recording"),
    kind === "merge" ? t("steps.newBox") : t("steps.revealed"),
  ];
}

function BoxStack({ n }: { n: number }) {
  return (
    <div aria-hidden="true" className="flex justify-center gap-2 py-2">
      {Array.from({ length: Math.max(1, n) }, (_, i) => (
        <span
          key={i}
          className="flex size-12 items-center justify-center rounded-[14px] bg-accent text-white"
        >
          <Gift size={22} />
        </span>
      ))}
    </div>
  );
}

function JobBody({
  flow,
  job,
  auth,
  actions,
  closeBtn,
}: {
  flow: Extract<Flow, { step: "job" }>;
  job: LotteryJob | undefined;
  auth: Auth;
  actions: ReturnType<typeof useBoxActions>;
  closeBtn: ReactNode;
}) {
  const t = useTranslations("rewards.action");
  const [since] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const running = ACTIVE(job);
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => {
      setNow(Date.now());
    }, 5_000);
    return () => {
      clearInterval(id);
    };
  }, [running]);

  const note =
    flow.note === null ? null : (
      <div
        role="status"
        className="flex flex-col gap-0.5 rounded-tile bg-accent-tint px-4 py-3 text-sm text-accent-ink"
      >
        <b>{t(`${flow.note}.title`, { kind: flow.kind })}</b>
        <span>
          {flow.note === "already"
            ? t("already.body", { kind: flow.kind, id: flow.jobId })
            : t("recovered.body", { id: flow.jobId, status: job?.status ?? "" })}
        </span>
      </div>
    );

  if (job?.status === "failed")
    return (
      <>
        <ErrorBanner said={job.error ?? null} />
        <FailedBody flow={flow} />
        <Buttons>
          {/* Job thất bại là kết quả rõ ràng: thử lại lấy sign-params mới (quy tắc 7). */}
          <Button onClick={() => void actions.retry()}>{t("tryAgain")}</Button>
          {closeBtn}
        </Buttons>
      </>
    );

  if (job?.status === "revealed")
    return <Result flow={flow} job={job} auth={auth} actions={actions} />;

  const at =
    flow.kind === "claim" ? (job?.status === "pending" ? 1 : 0) : job?.status === "pending" ? 2 : 1;
  return (
    <>
      {note}
      <p className="m-0 text-xs text-ink-2 tabular-nums">{t("job", { id: flow.jobId })}</p>
      <div className="flex justify-center py-1">
        <span
          aria-hidden="true"
          className="flex size-16 items-center justify-center rounded-[18px] bg-accent text-white motion-safe:animate-[rw-breathe_1.6s_ease-in-out_infinite]"
        >
          <Gift size={30} />
        </span>
      </div>
      <Stepper steps={stepsOf(flow.kind, t)} at={at} />
      {now - since > SLOW_MS ? <p className="m-0 text-xs text-ink-2">{t("slow")}</p> : null}
      <p className="m-0 text-xs text-ink-2">{t("canClose")}</p>
      <Buttons>{closeBtn}</Buttons>
    </>
  );
}

function Result({
  flow,
  job,
  auth,
  actions,
}: {
  flow: Extract<Flow, { step: "job" }>;
  job: LotteryJob;
  auth: Auth;
  actions: ReturnType<typeof useBoxActions>;
}) {
  const t = useTranslations("rewards.action");
  const boxes = useRewardsBoxes(auth);
  const done = (
    <Button onClick={actions.close} className="self-start">
      {t("done")}
    </Button>
  );

  if (flow.kind === "claim") {
    const minted = job.minted ?? [];
    const after = boxes.data?.total;
    return (
      <>
        <div className="flex flex-col items-center gap-3 rounded-tile bg-surface-2 px-4 py-4">
          <ul className="m-0 flex list-none flex-wrap justify-center gap-2 p-0">
            {minted.map((m, i) => (
              <li
                key={m.tokenId}
                style={{ animationDelay: `${String(i * 120)}ms` }}
                className="flex flex-col items-center gap-0.5 rounded-[12px] border border-border bg-surface px-3 py-2 text-xs font-extrabold motion-safe:animate-[rw-drop_420ms_cubic-bezier(.34,1.56,.64,1)_both] motion-reduce:animate-[rw-fade_150ms_linear]"
              >
                <Level level={m.level} />
                <span className="font-semibold text-ink-2 tabular-nums">#{m.tokenId}</span>
              </li>
            ))}
          </ul>
          {flow.before === null || after === undefined || after === flow.before ? null : (
            <span className="text-sm font-bold tabular-nums">
              {t("claim.backpack", {
                before: formatCount(flow.before) ?? "",
                after: formatCount(after) ?? "",
              })}
            </span>
          )}
        </div>
        <Buttons>
          <Link
            href="/rewards?tab=boxes"
            onClick={actions.close}
            className="flex min-h-tap items-center rounded-control bg-accent px-4 text-sm font-semibold text-white no-underline"
          >
            {t("claim.openThem")}
          </Link>
          <Button variant="secondary" onClick={actions.close}>
            {t("done")}
          </Button>
        </Buttons>
      </>
    );
  }

  if (flow.kind === "merge") {
    const r = job.result;
    return (
      <>
        {r == null ? null : (
          <div className="flex flex-col items-center gap-2">
            <div className="flex flex-col items-center gap-1 rounded-[18px] bg-pos-bg px-7 py-4 motion-safe:animate-[rw-pop_320ms_cubic-bezier(.34,1.56,.64,1)_both] motion-reduce:animate-[rw-fade_150ms_linear]">
              <span className="text-xs">{t("merge.newBox")}</span>
              <b className="tabular-nums">#{r.tokenId}</b>
              <Level level={r.level} />
            </div>
            <p className="m-0 text-sm text-ink-2">
              {t("merge.used", { n: r.consumedTokenIds.length, level: flow.level ?? "" })}
            </p>
          </div>
        )}
        <Buttons>
          {r == null ? null : (
            <Button
              onClick={() => {
                actions.start({
                  kind: "open",
                  count: 1,
                  level: r.level,
                  tokenIds: [r.tokenId],
                  before: null,
                });
              }}
            >
              {t("merge.openIt")}
            </Button>
          )}
          <Button variant="secondary" onClick={actions.close}>
            {t("done")}
          </Button>
        </Buttons>
      </>
    );
  }

  return <OpenResult flow={flow} job={job} done={done} />;
}

function OpenResult({
  flow,
  job,
  done,
}: {
  flow: Extract<Flow, { step: "job" }>;
  job: LotteryJob;
  done: ReactNode;
}) {
  const t = useTranslations("rewards.action");
  const tf = useTranslations("rewards.feed");
  const items = job.boxes ?? [];
  const [skip, setSkip] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Lật lần lượt 520 ms, lệch 140 ms; quá 8 box thì phần còn lại hiện cùng lúc.
  const total = Math.min(items.length, FLIP_MAX) * 140 + 520;
  useEffect(() => {
    timer.current = setTimeout(() => {
      setRevealed(true);
    }, total);
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, [total]);
  const finished = revealed || skip;

  // Tổng theo tài sản (cộng thập phân các phần thưởng SoDEX trả).
  const byAsset = new Map<string, { symbol: string; amount: string; usd: string | null }>();
  for (const b of items) {
    if (b.reward == null) continue;
    const key = `${b.reward.asset.address}:${b.reward.asset.symbol}`;
    const cur = byAsset.get(key);
    const usd = b.rewardUsd ?? null;
    byAsset.set(key, {
      symbol: b.reward.asset.symbol,
      amount: cur === undefined ? b.reward.amount : add(cur.amount, b.reward.amount).toFixed(),
      usd:
        cur === undefined
          ? usd
          : cur.usd === null || usd === null
            ? null
            : add(cur.usd, usd).toFixed(),
    });
  }
  const pfps = items.flatMap((b) =>
    b.pfpTokenId === null || b.pfpTokenId === undefined ? [] : [b.pfpTokenId],
  );

  return (
    <>
      <ul className="m-0 grid list-none grid-cols-3 gap-2 p-0 sm:grid-cols-5">
        {items.map((b, i) => {
          const amount = formatTokenAmount(b.reward?.amount);
          const usd = formatUsd(b.rewardUsd);
          const instant = skip || i >= FLIP_MAX;
          return (
            <li
              key={b.tokenId}
              style={instant ? undefined : { animationDelay: `${String(i * 140)}ms` }}
              className={`flex flex-col items-center gap-0.5 rounded-[12px] border border-border bg-surface px-1.5 py-2 text-center text-xs tabular-nums ${instant ? "motion-reduce:animate-[rw-fade_150ms_linear]" : "motion-safe:animate-[rw-flip_520ms_ease-out_both] motion-reduce:animate-[rw-fade_150ms_linear]"}`}
            >
              <span className="text-ink-2">#{b.tokenId}</span>
              {flow.level === null ? null : <b>{flow.level}</b>}
              <b>
                {amount === null || b.reward == null ? null : `${amount} ${b.reward.asset.symbol}`}
              </b>
              {usd === null ? null : <span className="text-ink-2">{usd}</span>}
              {b.pfpTokenId === null || b.pfpTokenId === undefined ? null : (
                <span className="rounded-full bg-unknown-bg px-1.5 text-[10px] font-extrabold text-unknown">
                  {tf("pfp")}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {!finished && items.length > 1 ? (
        <Buttons>
          <Button
            variant="secondary"
            onClick={() => {
              setSkip(true);
            }}
          >
            {t("skip")}
          </Button>
        </Buttons>
      ) : (
        <>
          {[...byAsset.values()].map((a) => (
            <div
              key={a.symbol}
              className="flex items-center justify-between gap-3 rounded-tile bg-surface-2 px-3 py-2.5 text-sm tabular-nums"
            >
              <b>{a.symbol}</b>
              <span>
                <b>{formatTokenAmount(a.amount) ?? a.amount}</b>{" "}
                {a.usd === null ? null : (
                  <span className="text-xs text-ink-2">
                    {t("open.approx", { usd: formatUsd(a.usd) ?? "" })}
                  </span>
                )}
              </span>
            </div>
          ))}
          {pfps.map((id) => (
            <PfpDrop key={id} id={id} />
          ))}
          <p className="m-0 text-xs text-ink-2">{t("open.usdNote")}</p>
          {done}
        </>
      )}
    </>
  );
}

function PfpDrop({ id }: { id: number }) {
  const t = useTranslations("rewards.action");
  const tb = useTranslations("rewards.boxes");
  const profile = useCybereatorProfile(id);
  const stage = profile.data?.stage;
  return (
    <div className="flex items-center gap-3 rounded-tile border border-border px-3 py-2.5">
      <span
        aria-hidden="true"
        className="size-11 flex-none rounded-[12px] bg-gradient-to-br from-accent-tint to-unknown-bg"
      />
      <span className="flex min-w-0 flex-1 flex-col text-sm">
        <b>{t("open.pfp", { id })}</b>
        <span className="text-xs text-ink-2">
          {stage === "revealed"
            ? tb("pfps.revealed")
            : stage === "unopened"
              ? tb("pfps.unopened")
              : stage === "opening"
                ? tb("pfps.opening")
                : null}
        </span>
      </span>
      <a
        href={SODEX_BLIND_BOX_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="text-sm font-bold whitespace-nowrap text-accent-ink no-underline"
      >
        {tb("openOnSodex")}
      </a>
    </div>
  );
}

/** Dải "xong khi popup đã đóng" (bản phác 18): job vừa xong + "See results". */
export function DoneStrip({ auth }: { auth: Auth }) {
  const t = useTranslations("rewards.action");
  const state = useActionState();
  const actions = useBoxActions(auth);
  const done = state.done;
  if (done === null || state.open) return null;
  const p = done.pick;
  const title =
    p.kind === "claim"
      ? t("claim.result", { n: p.count })
      : p.kind === "merge"
        ? t("merge.result")
        : t("open.result", { n: p.count });
  return (
    <div
      role="status"
      className="flex items-center gap-3 rounded-[14px] bg-pos-bg px-3 py-2.5 text-pos"
    >
      <span
        aria-hidden="true"
        className="flex size-6 flex-none items-center justify-center rounded-full bg-pos text-white"
      >
        <Check size={14} strokeWidth={3} />
      </span>
      <b className="min-w-0 flex-1 truncate text-sm">{title}</b>
      <button
        type="button"
        onClick={() => {
          actions.view(done.jobId, p);
        }}
        className="min-h-tap flex-none text-sm font-bold text-pos"
      >
        {t("seeResults")}
      </button>
    </div>
  );
}
