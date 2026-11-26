"use client";

import { sameWallet } from "@drift/shared";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useConfig, useConnection, useSignMessage } from "wagmi";
import { getConnection } from "wagmi/actions";
import type { z } from "zod";

import { useSodexConnection } from "@/lib/queries";

import { RewardsError, rewardsRequest, type RewardsRequest } from "./client";
import { jwtClaimRows } from "./shape";
import { signInToRewards, type SignInResult } from "./sign-in";
import {
  clearAllRewardsTokens,
  clearRewardsToken,
  readRewardsToken,
  subscribeRewardsTokens,
} from "./token-store";

// Trạng thái đăng nhập rewards của tab này (DEC-397). Token chỉ đọc trong hook và gắn vào request tới gateway; không
// trả token ra component.

export type RewardsPhase = "idle" | "signing";

export function useRewardsAuth() {
  const config = useConfig();
  const sodex = useSodexConnection();
  const master = sodex.data?.connection?.address ?? null;
  const { address: connected } = useConnection();
  const { mutateAsync: signMessageAsync } = useSignMessage();
  const [phase, setPhase] = useState<RewardsPhase>("idle");
  const [last, setLast] = useState<SignInResult | null>(null);
  const [expired, setExpired] = useState(false);
  const [error, setError] = useState<RewardsError | null>(null);

  const signedIn = useSyncExternalStore(
    subscribeRewardsTokens,
    () => readRewardsToken(master) !== null,
    () => false,
  );

  /** Tên claim JWT (chẩn đoán hạn token); không bao giờ chứa token. */
  const claims = useMemo(
    () => (signedIn ? jwtClaimRows(readRewardsToken(master)) : null),
    [signedIn, master],
  );

  // Token của ví khác master (account đổi, tài khoản DeskLabs khác trên cùng tab) bỏ ngay.
  useEffect(() => {
    if (master !== null) clearAllRewardsTokens(master);
  }, [master]);
  // Đổi ví trong ví sang địa chỉ khác master: xoá token.
  useEffect(() => {
    if (connected !== undefined && master !== null && !sameWallet(connected, master))
      clearAllRewardsTokens();
  }, [connected, master]);

  const signIn = useCallback(async (): Promise<SignInResult | null> => {
    setError(null);
    setPhase("signing");
    try {
      const result = await signInToRewards({
        master,
        // Đọc kết nối lúc bấm (ví có thể vừa được chọn).
        connected: getConnection(config).address,
        signMessage: (args) => signMessageAsync(args),
      });
      setLast(result);
      if (result.kind === "signed_in") setExpired(false);
      return result;
    } catch (e) {
      setError(e instanceof RewardsError ? e : new RewardsError("network", 0));
      return null;
    } finally {
      setPhase("idle");
    }
  }, [config, master, signMessageAsync]);

  const signOut = useCallback(() => {
    clearRewardsToken(master);
    setLast(null);
    setExpired(false);
  }, [master]);

  /** Request cần JWT: 401 thì xoá token và báo hết hạn. */
  const authed = useCallback(
    async <T extends z.ZodType>(req: Omit<RewardsRequest<T>, "token">): Promise<z.output<T>> => {
      const token = readRewardsToken(master);
      if (master === null || token === null) throw new RewardsError("expired", 401);
      try {
        return await rewardsRequest({ ...req, token });
      } catch (e) {
        if (e instanceof RewardsError && e.kind === "expired") {
          clearRewardsToken(master);
          setExpired(true);
        }
        throw e;
      }
    },
    [master],
  );

  return {
    master,
    sodexLoading: sodex.isPending,
    connected,
    signedIn,
    claims,
    phase,
    last,
    expired,
    error,
    signIn,
    signOut,
    authed,
  };
}
