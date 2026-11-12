import type { Connector } from "wagmi";

/** WalletConnect chưa hiện QR sau ngần này thì coi như không khởi động được trong trình duyệt này. */
export const WC_START_TIMEOUT_MS = 12_000;

export class WalletConnectNotStarted extends Error {}

/**
 * Kết nối ví, riêng WalletConnect có canh giờ: quét QR có thể mất vài phút nên không giới hạn cả lượt, chỉ giới
 * hạn tới lúc modal có URI. Trình duyệt chặn phần khởi tạo (ví dụ Safari Lockdown Mode) thì `connect` treo mãi và
 * không báo lỗi, người dùng thấy nút bấm không có tác dụng.
 */
export function connectWatched<T>(
  connector: Pick<Connector, "type" | "emitter">,
  connect: () => Promise<T>,
  timeoutMs = WC_START_TIMEOUT_MS,
): Promise<T> {
  if (connector.type !== "walletConnect") return connect();
  return new Promise<T>((resolve, reject) => {
    const onMessage = ({ type }: { type: string }) => {
      if (type === "display_uri") clear();
    };
    const timer = setTimeout(() => {
      clear();
      reject(new WalletConnectNotStarted());
    }, timeoutMs);
    function clear() {
      clearTimeout(timer);
      connector.emitter.off("message", onMessage);
    }
    connector.emitter.on("message", onMessage);
    connect().then(resolve, reject).finally(clear);
  });
}
