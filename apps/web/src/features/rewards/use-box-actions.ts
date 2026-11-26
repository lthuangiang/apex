"use client";

import {
  lotteryMetaSchema,
  lotterySignParamsSchema,
  sameWallet,
  type LotteryJob,
} from "@drift/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useSyncExternalStore } from "react";
import { UserRejectedRequestError } from "viem";
import {
  useConfig,
  useConnect,
  useConnection,
  useDisconnect,
  useSignTypedData,
  useSwitchChain,
  type Connector,
} from "wagmi";
import { getConnection } from "wagmi/actions";

import { valueChain } from "@/lib/wagmi";
import { connectWatched } from "@/lib/watch-wallet";

import {
  actionToken,
  getActionState,
  newActionToken,
  setActionState,
  subscribeActions,
  type Flow,
  type Pick,
} from "./action-store";
import {
  actionOfJob,
  boxTypedData,
  contractMatches,
  findActiveJob,
  postAction,
  type PostOutcome,
} from "./actions";
import { RewardsError, rewardsRequest } from "./client";
import { REWARDS_KEY, type RewardsSession } from "./queries";

// Điều khiển popup Claim / Open / Merge (#551). Claim chỉ cần JWT; open / merge: sign-params mới → ví ký EIP-712 (chuyển
// ví sang ValueChain, chỉ đổi mạng, không gas) → POST một lần. Không bao giờ gửi lại POST không rõ kết quả (quy tắc 7).

type Auth = RewardsSession;

function isRejection(e: unknown): boolean {
  return (
    e instanceof UserRejectedRequestError ||
    (e instanceof Error && e.name === "UserRejectedRequestError") ||
    (typeof e === "object" && e !== null && "code" in e && e.code === 4001)
  );
}

function pickOf(f: Flow): Pick {
  return { kind: f.kind, count: f.count, level: f.level, tokenIds: f.tokenIds, before: f.before };
}

/** Thông tin hiển thị của một job khôi phục từ `jobs?active=true` (không có lựa chọn ban đầu của người dùng). */
export function pickOfJob(job: LotteryJob): Pick {
  const kind = actionOfJob(job);
  const tokenIds = (job.boxes ?? []).map((b) => b.tokenId);
  const count =
    kind === "claim"
      ? (job.minted?.length ?? 0)
      : kind === "merge"
        ? (job.result?.consumedTokenIds.length ?? tokenIds.length)
        : tokenIds.length;
  return { kind, count, level: job.result?.level ?? null, tokenIds, before: null };
}

const KEEP_ON_CLOSE: readonly Flow["step"][] = ["sending", "checking", "job"];

export function useActionState() {
  return useSyncExternalStore(subscribeActions, getActionState, getActionState);
}

export function useBoxActions(auth: Auth) {
  const config = useConfig();
  const qc = useQueryClient();
  const { isConnected } = useConnection();
  const { mutateAsync: switchChainAsync } = useSwitchChain();
  const { mutateAsync: signTypedDataAsync } = useSignTypedData();
  const { mutateAsync: connectAsync } = useConnect();
  const { mutateAsync: disconnectAsync } = useDisconnect();
  const { authed, master } = auth;

  const setFlow = useCallback((flow: Flow) => {
    setActionState({ flow });
  }, []);

  const start = useCallback((pick: Pick) => {
    newActionToken();
    setActionState({ open: true, flow: { step: "confirm", ...pick }, done: null });
  }, []);

  /** Mở lại đúng bước của một job (View / See results / khôi phục). */
  const view = useCallback((jobId: number, pick: Pick, note: "recovered" | null = null) => {
    const cur = getActionState().flow;
    if (cur?.step === "job" && cur.jobId === jobId) {
      setActionState({ open: true, done: null });
      return;
    }
    newActionToken();
    setActionState({ open: true, done: null, flow: { step: "job", jobId, note, ...pick } });
  }, []);

  const close = useCallback(() => {
    const f = getActionState().flow;
    if (f !== null && KEEP_ON_CLOSE.includes(f.step)) {
      setActionState({ open: false });
      return;
    }
    // Chưa gửi gì: huỷ luồng (ví ký muộn sẽ bị bỏ, không gửi).
    newActionToken();
    setActionState({ open: false, flow: null });
  }, []);

  const handle = useCallback(
    async (pick: Pick, outcome: PostOutcome) => {
      void qc.invalidateQueries({ queryKey: [...REWARDS_KEY, "wallet"] });
      switch (outcome.kind) {
        case "job":
          setFlow({ step: "job", jobId: outcome.jobId, note: null, ...pick });
          return;
        case "already":
          setFlow({ step: "job", jobId: outcome.jobId, note: "already", ...pick });
          return;
        case "unknown": {
          setFlow({ step: "checking", ...pick });
          const id = await findActiveJob(authed, pick.kind);
          setFlow(
            id === null
              ? { step: "unsure", ...pick }
              : { step: "job", jobId: id, note: null, ...pick },
          );
          return;
        }
        case "rejected":
          setFlow({ step: "error", reason: "rejected", said: outcome.said, ...pick });
          return;
        case "expired":
          setFlow({ step: "error", reason: "expired", said: null, ...pick });
          return;
        case "busy":
          setFlow({ step: "error", reason: "busy", said: null, ...pick });
          return;
      }
    },
    [authed, qc, setFlow],
  );

  const confirm = useCallback(async () => {
    const f = getActionState().flow;
    if (f === null || master === null) return;
    const pick = pickOf(f);
    const my = newActionToken();
    if (pick.kind === "claim") {
      setFlow({ step: "sending", ...pick });
      await handle(pick, await postAction(authed, "lottery/treasure/open", { count: pick.count }));
      return;
    }
    const connected = getConnection(config).address;
    if (connected === undefined) {
      setFlow({ step: "picker", ...pick });
      return;
    }
    if (!sameWallet(connected, master)) {
      setFlow({ step: "error", reason: "wallet", said: null, connected, ...pick });
      return;
    }
    setFlow({ step: "wallet", ...pick });
    let params;
    try {
      // Mỗi lần thử lấy sign-params mới (nonce / deadline mới).
      params = await authed({
        path: "lottery/box/sign-params",
        query: { action: pick.kind },
        schema: lotterySignParamsSchema,
      });
    } catch (e) {
      // Chưa gửi gì cho SoDEX: báo lỗi, cho thử lại.
      const kind = e instanceof RewardsError ? e.kind : "network";
      setFlow({
        step: "error",
        reason: kind === "expired" ? "expired" : kind === "rate_limited" ? "busy" : "rejected",
        said: e instanceof RewardsError ? e.sodexMessage : null,
        ...pick,
      });
      return;
    }
    if (actionToken() !== my) return;
    if (params.chainId !== valueChain.id) {
      setFlow({ step: "error", reason: "rejected", said: null, ...pick });
      return;
    }
    // Ghim contract: verifyingContract phải là contract TreasureBox SoDEX công bố ở `lottery/meta`. Không đọc được meta
    // hoặc khác nhau thì không ký.
    let treasureBox: string | null | undefined = null;
    try {
      const meta = await qc.query({
        queryKey: [...REWARDS_KEY, "public", "meta"],
        queryFn: ({ signal }) =>
          rewardsRequest({ path: "lottery/meta", schema: lotteryMetaSchema, signal }),
        staleTime: 5 * 60_000,
        retry: false,
      });
      treasureBox = meta.contracts?.treasureBox;
    } catch {
      treasureBox = null;
    }
    if (actionToken() !== my) return;
    if (!contractMatches(params.verifyingContract, treasureBox)) {
      setFlow({ step: "error", reason: "rejected", said: null, ...pick });
      return;
    }
    let signature: string;
    try {
      if (getConnection(config).chainId !== valueChain.id)
        await switchChainAsync({ chainId: valueChain.id });
      signature = await signTypedDataAsync(boxTypedData(params, master, pick.tokenIds));
    } catch (e) {
      if (actionToken() !== my) return;
      if (isRejection(e)) setFlow({ step: "confirm", ...pick });
      else setFlow({ step: "error", reason: "rejected", said: null, ...pick });
      return;
    }
    // Đóng popup / huỷ trong lúc ví hỏi: bỏ chữ ký, không gửi.
    if (actionToken() !== my) return;
    setFlow({ step: "sending", ...pick });
    await handle(
      pick,
      await postAction(authed, pick.kind === "open" ? "lottery/box/open" : "lottery/box/merge", {
        tokenIds: pick.tokenIds,
        nonce: String(params.nonce),
        deadline: params.deadline,
        signature,
      }),
    );
  }, [authed, config, handle, master, qc, setFlow, signTypedDataAsync, switchChainAsync]);

  /** Chọn ví ở bước picker rồi ký tiếp (người dùng đã bấm ký). */
  const pickWallet = useCallback(
    async (connector: Connector) => {
      if (isConnected) await disconnectAsync().catch(() => undefined);
      const ok = await connectWatched(connector, () => connectAsync({ connector })).then(
        () => true,
        () => false,
      );
      const f = getActionState().flow;
      if (f === null) return;
      setFlow({ step: "confirm", ...pickOf(f) });
      if (ok) await confirm();
    },
    [confirm, connectAsync, disconnectAsync, isConnected, setFlow],
  );

  /** Thử lại sau lỗi rõ ràng / job failed: về xác nhận rồi ký lại với sign-params mới. */
  const retry = useCallback(async () => {
    const f = getActionState().flow;
    if (f === null) return;
    setFlow({ step: "confirm", ...pickOf(f) });
    await confirm();
  }, [confirm, setFlow]);

  return { start, view, close, confirm, retry, pickWallet };
}
