import { BotEdit, isMmSuggestion } from "@/features/bots";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// `?draft=`: bản nháp thay đổi từ Claude (MCP, DEC-223), chỉ điền sẵn form. `?suggest=`: gợi ý "Ways to lower it" của
// Market Making (DEC-TBD-mm-cost), cũng chỉ điền sẵn.
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ botId: string }>;
  searchParams: Promise<{ draft?: string; suggest?: string }>;
}) {
  const { botId } = await params;
  const { draft, suggest } = await searchParams;
  return (
    <BotEdit
      botId={botId}
      draftId={UUID.test(draft ?? "") ? draft : undefined}
      suggest={isMmSuggestion(suggest) ? suggest : undefined}
    />
  );
}
