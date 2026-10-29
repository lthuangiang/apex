"use client";

import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { WagmiProvider } from "wagmi";

import { ApiError } from "@/lib/api";
import { wagmiConfig } from "@/lib/wagmi";

/** Phiên hết hạn hoặc bị thu hồi (api trả UNAUTHENTICATED): về trang đăng ký / đăng nhập. */
function onApiError(error: unknown) {
  if (
    error instanceof ApiError &&
    error.code === "UNAUTHENTICATED" &&
    window.location.pathname !== "/signup" &&
    window.location.pathname !== "/signin"
  ) {
    window.location.assign("/signup");
  }
}

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        queryCache: new QueryCache({ onError: onApiError }),
        mutationCache: new MutationCache({ onError: onApiError }),
        // staleTime: component mount lại không refetch dữ liệu vừa tải (UI_REVIEW E1.4).
        defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true, staleTime: 15_000 } },
      }),
  );
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
