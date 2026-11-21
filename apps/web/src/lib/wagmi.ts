import { defineChain } from "viem";
import { createConfig, http, type CreateConnectorFn } from "wagmi";
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
//
// #368: `createConfig` gọi `connector.setup()` ngay khi tạo config, và `setup()` của WalletConnect khởi tạo
// EthereumProvider, kéo theo storage dùng `indexedDB`. Lúc SSR (Node không có `indexedDB`) việc này ném
// `unhandledRejection: ReferenceError: indexedDB is not defined`. Vì vậy connector WalletConnect chỉ được tạo ở
// trình duyệt. Server không cần nó: bộ chọn ví chỉ hiện sau khi người dùng bấm (render ở client), và ví EIP-6963
// cũng chỉ có ở client.
export function wagmiConnectors(projectId: string, browser: boolean): CreateConnectorFn[] {
  return [
    injected({ shimDisconnect: true }),
    ...(projectId === "" || !browser
      ? []
      : [
          walletConnect({
            projectId,
            showQrModal: true,
            metadata: {
              name: "DeskLabs",
              description: "Automated trading strategies, powered by SoDEX Builder Code",
              url: window.location.origin,
              icons: [],
            },
          }),
        ]),
  ];
}

export const wagmiConfig = createConfig({
  chains: [valueChain],
  multiInjectedProviderDiscovery: true,
  connectors: wagmiConnectors(walletConnectProjectId, typeof window !== "undefined"),
  transports: { [valueChain.id]: http() },
  ssr: true,
});
