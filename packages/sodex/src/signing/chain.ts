// Chain ID của SoDEX (docs/SODEX.md mục 5.1). DEC-23: chỉ dùng mainnet.
export const SODEX_MAINNET_CHAIN_ID = 286623n;

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Byte đầu của `X-API-Sign`: 0x01 cho action giao dịch, 0x02 cho action universal. */
export const SignaturePrefix = { exchange: "01", universal: "02" } as const;
export type SignaturePrefix = (typeof SignaturePrefix)[keyof typeof SignaturePrefix];

export const ApiKeyType = { evm: 1 } as const;
