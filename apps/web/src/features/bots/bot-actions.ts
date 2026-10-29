import { BotState, ReasonCode, type BotSummary } from "@drift/shared";

interface Action {
  href: string;
  label: string;
}

/**
 * Một nút chính theo trạng thái + menu "⋯" cho phần còn lại (UI_REVIEW J4, DEC-72).
 * Bot paused vì key không dùng được: nút chính là "Renew key" (Resume chắc chắn fail).
 */
export function botActions(
  b: Pick<BotSummary, "id" | "state" | "reasonCode">,
  t: (key: "continue" | "resume" | "view" | "open" | "edit" | "renewKey") => string,
): { primary: Action; more: Action[] } {
  const open = { href: `/agent/${b.id}`, label: t("open") };
  const edit = { href: `/bots/${b.id}/edit`, label: t("edit") };
  if (b.state === BotState.draft) return { primary: { ...edit, label: t("continue") }, more: [] };
  if (b.state === BotState.paused) {
    if (b.reasonCode === ReasonCode.apiKeyUnusable) {
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
