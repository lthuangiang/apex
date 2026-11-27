import { rewardsNonceSchema, rewardsVerifySchema, sameWallet } from "@drift/shared";
import { UserRejectedRequestError } from "viem";

import { rewardsRequest } from "./client";
import { saveRewardsToken } from "./token-store";

// Đăng nhập rewards (DEC-397, docs.sodex.com › Wallet sign-in): `auth/nonce` → `personal_sign` đúng `data.message`
// → `auth/verify` (`autoSign: false`) → JWT vào localStorage theo ví (DEC-401). Ví ký phải là master wallet SoDEX của tài
// khoản DeskLabs: so TRƯỚC khi xin nonce / ký; khác thì không ký gì. Không chuyển mạng (personal_sign không cần), không
// tự bật ví, không giao dịch on-chain.

export type SignInResult =
  | { kind: "signed_in" }
  | { kind: "no_sodex" }
  | { kind: "no_wallet" }
  | { kind: "wrong_wallet"; connected: string }
  | { kind: "rejected" };

export interface SignInDeps {
  /** Master wallet của account SoDEX đã kết nối (`/api/v1/sodex/connection`); null = chưa kết nối. */
  master: string | null;
  /** Ví đang kết nối trong wagmi, đọc lúc bấm; undefined = chưa kết nối ví. */
  connected: string | undefined;
  signMessage: (args: { account: `0x${string}`; message: string }) => Promise<string>;
  request?: typeof rewardsRequest;
}

function isUserRejection(e: unknown): boolean {
  return (
    e instanceof UserRejectedRequestError ||
    (e instanceof Error && e.name === "UserRejectedRequestError") ||
    (typeof e === "object" && e !== null && "code" in e && e.code === 4001)
  );
}

export async function signInToRewards(deps: SignInDeps): Promise<SignInResult> {
  const { master, connected } = deps;
  if (master === null) return { kind: "no_sodex" };
  if (connected === undefined) return { kind: "no_wallet" };
  if (!sameWallet(connected, master)) return { kind: "wrong_wallet", connected };
  const request = deps.request ?? rewardsRequest;
  const login = { address: master, type: "sign_in" } as const;
  const { message } = await request({
    method: "POST",
    path: "auth/nonce",
    body: login,
    schema: rewardsNonceSchema,
  });
  let signature: string;
  try {
    signature = await deps.signMessage({ account: connected as `0x${string}`, message });
  } catch (e) {
    if (isUserRejection(e)) return { kind: "rejected" };
    throw e;
  }
  const { accessToken } = await request({
    method: "POST",
    path: "auth/verify",
    body: { ...login, message, signature, autoSign: false },
    schema: rewardsVerifySchema,
  });
  saveRewardsToken(master, accessToken);
  return { kind: "signed_in" };
}
