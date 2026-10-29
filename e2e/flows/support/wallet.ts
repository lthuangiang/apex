import type { Page } from "@playwright/test";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";

// Ví EIP-1193 tối giản cho E2E: trả về một địa chỉ, ở sẵn ValueChain (286623) và ký
// `eth_signTypedData_v4` trong Node bằng khoá test. Không bao giờ dùng khoá thật.

const typedDataSchema = z.object({
  domain: z.object({
    name: z.string(),
    version: z.string(),
    chainId: z.union([z.string(), z.number()]),
    verifyingContract: z.string(),
  }),
  types: z.record(z.string(), z.array(z.object({ name: z.string(), type: z.string() }))),
  primaryType: z.string(),
  message: z.record(z.string(), z.unknown()),
});

export async function installWallet(page: Page, privateKey: Hex) {
  const account = privateKeyToAccount(privateKey);
  await page.exposeFunction("__e2eSignTypedData", async (json: string) => {
    const data = typedDataSchema.parse(JSON.parse(json));
    const fields = data.types[data.primaryType] ?? [];
    const message = Object.fromEntries(
      fields.map((f) => [
        f.name,
        f.type.startsWith("uint") && f.type !== "uint8"
          ? BigInt(String(data.message[f.name]))
          : data.message[f.name],
      ]),
    );
    // viem tự thêm EIP712Domain; bỏ bản ví gửi lên.
    const types = Object.fromEntries(
      Object.entries(data.types).filter(([name]) => name !== "EIP712Domain"),
    );
    return account.signTypedData({
      domain: {
        ...data.domain,
        chainId: BigInt(data.domain.chainId),
        verifyingContract: data.domain.verifyingContract as Hex,
      },
      types,
      primaryType: data.primaryType,
      message,
    });
  });
  await page.addInitScript((address: string) => {
    const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
    const w = window as unknown as Record<string, unknown>;
    w.ethereum = {
      isMetaMask: true,
      request: async ({ method, params }: { method: string; params?: unknown[] }) => {
        switch (method) {
          case "eth_requestAccounts":
          case "eth_accounts":
            return [address];
          case "eth_chainId":
            return "0x45f9f";
          case "net_version":
            return "286623";
          case "wallet_switchEthereumChain":
          case "wallet_addEthereumChain":
            return null;
          case "wallet_requestPermissions":
          case "wallet_getPermissions":
            return [{ parentCapability: "eth_accounts" }];
          case "eth_signTypedData_v4":
            return (w.__e2eSignTypedData as (json: string) => Promise<string>)(String(params?.[1]));
          default:
            throw Object.assign(new Error(`Unsupported method ${method}`), { code: 4200 });
        }
      },
      on: (event: string, fn: (...args: unknown[]) => void) => {
        listeners.set(event, [...(listeners.get(event) ?? []), fn]);
      },
      removeListener: () => undefined,
    };
  }, account.address);
  return account.address;
}
