import { REASON_CODE_META, ReasonCode } from "@drift/shared";

// Ý nghĩa và cách xử lý reason code cho team (chép từ docs/DOMAIN.md mục 7.2). Dữ liệu trả về của tool, không phải câu
// chữ UI.

const HOW: Record<ReasonCode, { meaning: string; resumeWhen: string | null }> = {
  BUILDER_FEE_REVOKED: {
    meaning:
      "The user's builder fee approval read back below 0.01% (or 0), so every bot was paused.",
    resumeWhen:
      "Approval reads back at least 0.01% on Spot and Perps; then the user resumes each bot.",
  },
  API_KEY_EXPIRED: {
    meaning: "The DeskLabs API key on SoDEX expired, so every bot was paused.",
    resumeWhen: "A new key is created and verified (Renew key in Settings).",
  },
  API_KEY_UNUSABLE: {
    meaning:
      "The key is active and not expired, but the signer could not sign with it (decrypt failed or SoDEX rejects it).",
    resumeWhen: "After the user signs a new key; then the user resumes each bot.",
  },
  API_KEY_DELETED: {
    meaning: "The DeskLabs key was deleted on SoDEX, so every bot was paused.",
    resumeWhen: "The account is connected again.",
  },
  RISK_DAILY_LOSS: {
    meaning: "The account hit its daily loss limit, so every bot was paused.",
    resumeWhen: "At the next daily reset (00:00 in the user's time zone).",
  },
  RISK_DRAWDOWN: {
    meaning: "The account hit its max drawdown limit, so every bot was paused.",
    resumeWhen: null,
  },
  BOT_MAX_LOSS: {
    meaning: "This bot reached the max loss the user set.",
    resumeWhen: "The user raises max loss in Edit.",
  },
  ORDER_REJECTED: {
    meaning: "SoDEX rejected an order of this bot.",
    resumeWhen: "The user reads the reason and resumes.",
  },
  INSUFFICIENT_BALANCE: {
    meaning: "The account did not have enough balance for this bot's next order.",
    resumeWhen: "The balance check passes.",
  },
  STOP_LOSS: { meaning: "This bot hit its stop loss and stopped.", resumeWhen: null },
  TAKE_PROFIT: { meaning: "This bot hit its take profit and stopped.", resumeWhen: null },
  EMERGENCY_HALT: { meaning: "The user ran Halt all; every bot stopped.", resumeWhen: null },
  BUDGET_DONE: {
    meaning: "This bot spent its cost budget and stopped as planned.",
    resumeWhen: null,
  },
  MAX_CYCLES: {
    meaning: "This bot reached its target or max cycles and stopped as planned.",
    resumeWhen: null,
  },
};

export function reasonCodeInfo(code: string) {
  if (!(Object.values(ReasonCode) as string[]).includes(code)) return null;
  const c = code as ReasonCode;
  const meta = REASON_CODE_META[c];
  return {
    code: c,
    outcome: meta.outcome,
    scope: meta.scope === "account" ? "every bot of the account" : "one bot",
    meaning: HOW[c].meaning,
    // null + reason thay vì đoán (quy tắc 1.8): stopped thì không resume; RISK_DRAWDOWN chưa chốt.
    resumeWhen: HOW[c].resumeWhen,
    ...(HOW[c].resumeWhen === null
      ? {
          resumeReason:
            meta.outcome === "stopped"
              ? "stopped bots are not resumed; use Duplicate"
              : "not_decided",
        }
      : {}),
    source: "docs/DOMAIN.md 7.2",
  };
}
