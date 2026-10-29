"use client";

import { signatureRequestSchema, type SignatureRequest, type TypedData } from "@drift/shared";
import type { Hex, TypedData as ViemTypedData, TypedDataDefinition } from "viem";
import { UserRejectedRequestError } from "viem";
import { useConfig, useSignTypedData, useSwitchChain } from "wagmi";
import { getConnection } from "wagmi/actions";

import { api } from "./api";
import { valueChain } from "./wagmi";

// Một chữ ký master wallet cho một signature request của api (DEC-30):
// chuyển ví sang ValueChain → ký → gửi chữ ký → nếu `unknown` thì chỉ ĐỌC LẠI, không gửi lại.

export const UNKNOWN_POLL_MS = 3000;

export type SignOutcome =
  | { kind: "rejected" }
  | { kind: "failed"; request: SignatureRequest }
  | { kind: "succeeded"; request: SignatureRequest };

/** Typed data từ api (uint64 dạng chuỗi) → tham số `signTypedData` (uint dạng bigint). */
export function toSignable(typedData: TypedData): TypedDataDefinition {
  const fields = typedData.types[typedData.primaryType] ?? [];
  const message = Object.fromEntries(
    fields.map((field) => {
      const value = typedData.message[field.name];
      const isBigUint = field.type.startsWith("uint") && field.type !== "uint8";
      return [field.name, isBigUint ? BigInt(String(value)) : value];
    }),
  );
  return {
    domain: {
      name: typedData.domain.name,
      version: typedData.domain.version,
      chainId: BigInt(typedData.domain.chainId),
      verifyingContract: typedData.domain.verifyingContract as Hex,
    },
    // Đã parse bằng zod ở api client; viem chỉ cần đúng hình dạng `{ name, type }[]`.
    types: typedData.types as unknown as ViemTypedData,
    primaryType: typedData.primaryType,
    message,
  };
}

export function useSodexSignature() {
  const config = useConfig();
  const { mutateAsync: switchChainAsync } = useSwitchChain();
  const { mutateAsync: signTypedDataAsync } = useSignTypedData();

  return async function signAndSubmit(
    request: SignatureRequest,
    hooks: { onSigned?: () => void; onUnknown?: () => void } = {},
  ): Promise<SignOutcome> {
    // Đọc kết nối lúc ký (không lấy từ lần render trước): ví có thể vừa được chọn ngay trước đó.
    if (getConnection(config).chainId !== valueChain.id)
      await switchChainAsync({ chainId: valueChain.id });
    let signature: Hex;
    try {
      signature = await signTypedDataAsync(toSignable(request.typedData));
    } catch (e) {
      if (
        e instanceof UserRejectedRequestError ||
        (e instanceof Error && e.name === "UserRejectedRequestError")
      ) {
        return { kind: "rejected" };
      }
      throw e;
    }
    hooks.onSigned?.();
    let result = await api(
      "POST",
      `/api/v1/sodex/signature-requests/${request.id}/signature`,
      signatureRequestSchema,
      {
        body: { signature },
        idempotencyKey: crypto.randomUUID(),
      },
    );
    while (result.status === "unknown") {
      hooks.onUnknown?.();
      await new Promise((resolve) => setTimeout(resolve, UNKNOWN_POLL_MS));
      result = await api(
        "POST",
        `/api/v1/sodex/signature-requests/${request.id}/reconciliation`,
        signatureRequestSchema,
        {
          idempotencyKey: crypto.randomUUID(),
        },
      );
    }
    return result.status === "succeeded"
      ? { kind: "succeeded", request: result }
      : { kind: "failed", request: result };
  };
}
