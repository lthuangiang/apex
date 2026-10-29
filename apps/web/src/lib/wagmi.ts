import { defineChain } from "viem";
import { createConfig, http } from "wagmi";
import { injected, walletConnect } from "wagmi/connectors";

// ValueChain mainnet (docs/SODEX.md mục 5.6). Ví phải ở chain này để ký typed data domain `universal`
// có chainId 286623. DRIFT chỉ ký, không gửi giao dịch (quy tắc 1.1).
export const valueChain = defineChain({
  id: 286623,
  name: "ValueChain",
  nativeCurrency: { name: "SOSO", symbol: "SOSO", decimals: 18 },
  rpcUrls: { default: { http: ["https://mainnet.valuechain.xyz"] } },
  blockExplorers: { default: { name: "ValueChain Scan", url: "https://main-scan.valuechain.xyz" } },
});

/** Project ID của WalletConnect Cloud (Reown); trống thì không có lựa chọn WalletConnect. */
export const walletConnectProjectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "";

// Ví extension (Binance Wallet, OKX, Bitget, MetaMask, Rabby…) được phát hiện qua EIP-6963
// (`multiInjectedProviderDiscovery`), mỗi ví thành một connector riêng có tên và icon. `injected()` là
// lựa chọn dự phòng cho ví chỉ gắn `window.ethereum`. WalletConnect cho ví trên điện thoại (quét QR).
export const wagmiConfig = createConfig({
  chains: [valueChain],
  multiInjectedProviderDiscovery: true,
  connectors: [
    injected({ shimDisconnect: true }),
    ...(walletConnectProjectId === ""
      ? []
      : [
          walletConnect({
            projectId: walletConnectProjectId,
            showQrModal: true,
            metadata: {
              name: "DRIFT",
              description: "Profit bots for SoDEX",
              url: typeof window === "undefined" ? "https://localhost" : window.location.origin,
              icons: [],
            },
          }),
        ]),
  ],
  transports: { [valueChain.id]: http() },
  ssr: true,
});
