import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";

import messages from "../../../../messages/en.json";
import { h1Text } from "../research/context-text";
import type { Tr } from "../research/text";

import { CTX_ETH, CTX_NA_WALLETS, CTX_NONE, CTX_V2 } from "./context-fixtures";

// #353: H1 context-v2 dùng tập ví nghiên cứu (top K của leaderboard). Câu chữ theo context version của snapshot: v2 ghi
// "research wallets (top {K} of the leaderboard)", snapshot context-v1 đã lưu vẫn ghi "tracked wallets".

const TZ = "Asia/Ho_Chi_Minh";
const t = createTranslator({
  locale: "en",
  messages,
  namespace: "signalAnalysis.research" as never,
}) as unknown as Tr;

const v2 = <T extends object>(base: T, h1: object) => ({
  ...base,
  contextVersion: "context-v2",
  h1: { ...(base as { h1: object }).h1, walletSetVersion: 3, walletSetSize: 30, ...h1 },
});

describe("H1 research wallets copy (#353)", () => {
  it("context-v2 names the research wallets with the set size", () => {
    expect(h1Text(CTX_V2, "ETH", TZ, t).text).toBe(
      "2 research wallets (top 30 of the leaderboard) added Long ETH in the 60 min before · $1.4M · first at 09:41",
    );
    const quiet = h1Text(v2(CTX_NONE, { walletsChecked: 27 }), "SOL", TZ, t);
    // N = ví thật sự được kiểm (đọc được trong 60 phút), không phải K.
    expect(quiet.tag).toBe("27 wallets checked · quiet");
    expect(quiet.text).toBe(
      "Checked 27 research wallets (top 30 of the leaderboard): none traded SOL in the 60 min before.",
    );
  });

  it("context-v2 Not available when no research wallet was read; no set size → no made-up K", () => {
    const na = h1Text(v2(CTX_NA_WALLETS, {}), "ETH", TZ, t);
    expect(na).toMatchObject({
      answer: "na",
      tag: "No research wallet has data",
      text: "No research wallet (top 30 of the leaderboard) was read in the 60 min before, so there is no whale data. The signal is left out of the H1 comparison.",
    });
    const noSet = h1Text(
      v2(CTX_NA_WALLETS, { walletSetVersion: null, walletSetSize: null }),
      "ETH",
      TZ,
      t,
    );
    expect(noSet.text).toBe(
      "No research wallet (top of the leaderboard) was read in the 60 min before, so there is no whale data. The signal is left out of the H1 comparison.",
    );
  });

  it("a saved context-v1 snapshot keeps the tracked wallets copy", () => {
    expect(CTX_ETH.contextVersion).toBe("context-v1");
    expect(h1Text(CTX_ETH, "ETH", TZ, t).text).toBe(
      "2 tracked wallets added Long ETH in the 60 min before · $1.4M · first at 09:41",
    );
  });
});
