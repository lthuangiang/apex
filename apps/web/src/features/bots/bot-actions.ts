import { BotState, ReasonCode, Strategy, type BotSummary } from "@drift/shared";

import { signalResearchBotHref } from "@/features/signal-analysis/research/mode-memory";

interface Action {
  href: string;
  label: string;
}

/**
 * Một nút chính theo trạng thái + menu "⋯" cho phần còn lại (UI_REVIEW J4, DEC-72).
 * Bot paused vì key không dùng được: nút chính là "Renew key" (Resume chắc chắn fail), trừ khi key hiện tại
 * đã `active` (đã renew sau lần pause, UI_REVIEW N2) thì nút chính là "Resume".
 */
export function botActions(
  b: Pick<BotSummary, "id" | "state" | "reasonCode"> & Partial<Pick<BotSummary, "strategy">>,
  t: (key: "continue" | "resume" | "view" | "open" | "edit" | "renewKey") => string,
  keyStatus: string | null = null,
  /** #472: nhãn "Open in Signal Research" (PM duyệt) cho bot news, thay Edit / Continue (Strategy Lab không có form). */
  openInSignalResearch: string | null = null,
): { primary: Action; more: Action[] } {
  const open = { href: `/agent/${b.id}`, label: t("open") };
  const news = b.strategy === Strategy.newsSignal && openInSignalResearch !== null;
  const edit = news
    ? { href: signalResearchBotHref(b.id), label: openInSignalResearch }
    : { href: `/bots/${b.id}/edit`, label: t("edit") };
  if (b.state === BotState.draft)
    return { primary: news ? edit : { ...edit, label: t("continue") }, more: [] };
  if (b.state === BotState.paused) {
    if (b.reasonCode === ReasonCode.apiKeyUnusable && keyStatus !== "active") {
      return { primary: { href: "/settings", label: t("renewKey") }, more: [open, edit] };
    }
    return { primary: { ...open, label: t("resume") }, more: [edit] };
  }
  if (b.state === BotState.running) return { primary: open, more: [edit] };
  if (b.state === BotState.stopped || b.state === BotState.archived) {
    return { primary: { ...open, label: t("view") }, more: [] };
  }
  return { primary: open, more: [] };
}
