import { assertNever } from "@drift/shared";
import type { Hex, LocalAccount, TypedDataDomain } from "viem";

import { SignaturePrefix, SODEX_MAINNET_CHAIN_ID, ZERO_ADDRESS } from "./chain";
import { toSodexSignature } from "./signature";

// Action universal do master wallet ký (docs/SODEX.md mục 5.2).
// Type string và thứ tự field lấy đúng từ tài liệu SoDEX; thứ tự field là một phần của hash.

export function universalDomain(chainId: bigint = SODEX_MAINNET_CHAIN_ID): TypedDataDomain {
  return { name: "universal", version: "1", chainId, verifyingContract: ZERO_ADDRESS };
}

export const universalTypes = {
  AddAPIKey: [
    { name: "accountID", type: "uint64" },
    { name: "name", type: "string" },
    { name: "keyType", type: "uint8" },
    { name: "publicKey", type: "bytes" },
    { name: "expiresAt", type: "uint64" },
    { name: "nonce", type: "uint64" },
  ],
  AddAPIKeyWithBuilder: [
    { name: "chainID", type: "uint64" },
    { name: "nonce", type: "uint64" },
    { name: "accountID", type: "uint64" },
    { name: "name", type: "string" },
    { name: "keyType", type: "uint8" },
    { name: "publicKey", type: "bytes" },
    { name: "expiresAt", type: "uint64" },
    { name: "builderID", type: "uint64" },
    { name: "maxFeeRate", type: "uint64" },
  ],
  UserSignedAddPermissionedAPIKeyAction: [
    { name: "chainID", type: "uint64" },
    { name: "nonce", type: "uint64" },
    { name: "accountID", type: "uint64" },
    { name: "name", type: "string" },
    { name: "keyType", type: "uint8" },
    { name: "publicKey", type: "bytes" },
    { name: "expiresAt", type: "uint64" },
    { name: "permissions", type: "uint64" },
  ],
  ApproveBuilderFeeAction: [
    { name: "chainID", type: "uint64" },
    { name: "nonce", type: "uint64" },
    { name: "accountID", type: "uint64" },
    { name: "builderID", type: "uint64" },
    { name: "maxFeeRate", type: "uint64" },
  ],
} as const;

export interface AddApiKeyMessage {
  accountID: bigint;
  name: string;
  keyType: number;
  publicKey: Hex;
  expiresAt: bigint;
  nonce: bigint;
}

export interface AddApiKeyWithBuilderMessage extends AddApiKeyMessage {
  chainID: bigint;
  builderID: bigint;
  maxFeeRate: bigint;
}

export interface AddPermissionedApiKeyMessage extends AddApiKeyMessage {
  chainID: bigint;
  permissions: bigint;
}

export interface ApproveBuilderFeeMessage {
  chainID: bigint;
  nonce: bigint;
  accountID: bigint;
  builderID: bigint;
  maxFeeRate: bigint;
}

export type UniversalAction =
  | { primaryType: "AddAPIKey"; message: AddApiKeyMessage }
  | { primaryType: "AddAPIKeyWithBuilder"; message: AddApiKeyWithBuilderMessage }
  | { primaryType: "UserSignedAddPermissionedAPIKeyAction"; message: AddPermissionedApiKeyMessage }
  | { primaryType: "ApproveBuilderFeeAction"; message: ApproveBuilderFeeMessage };

/** Ký bằng một account local. Chỉ dùng trong test và trong `signer`; ví thật ký ở trình duyệt. */
export async function signUniversal(
  account: LocalAccount,
  action: UniversalAction,
  chainId: bigint = SODEX_MAINNET_CHAIN_ID,
): Promise<Hex> {
  const domain = universalDomain(chainId);
  let signature: Hex;
  switch (action.primaryType) {
    case "AddAPIKey":
      signature = await account.signTypedData({
        domain,
        types: { AddAPIKey: universalTypes.AddAPIKey },
        primaryType: "AddAPIKey",
        message: action.message,
      });
      break;
    case "AddAPIKeyWithBuilder":
      signature = await account.signTypedData({
        domain,
        types: { AddAPIKeyWithBuilder: universalTypes.AddAPIKeyWithBuilder },
        primaryType: "AddAPIKeyWithBuilder",
        message: action.message,
      });
      break;
    case "UserSignedAddPermissionedAPIKeyAction":
      signature = await account.signTypedData({
        domain,
        types: {
          UserSignedAddPermissionedAPIKeyAction:
            universalTypes.UserSignedAddPermissionedAPIKeyAction,
        },
        primaryType: "UserSignedAddPermissionedAPIKeyAction",
        message: action.message,
      });
      break;
    case "ApproveBuilderFeeAction":
      signature = await account.signTypedData({
        domain,
        types: { ApproveBuilderFeeAction: universalTypes.ApproveBuilderFeeAction },
        primaryType: "ApproveBuilderFeeAction",
        message: action.message,
      });
      break;
    default:
      return assertNever(action);
  }
  return toSodexSignature(signature, SignaturePrefix.universal);
}
