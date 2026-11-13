import { BotEdit } from "@/features/bots";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// `?draft=`: bản nháp thay đổi từ Claude (MCP, DEC-223), chỉ điền sẵn form.
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ botId: string }>;
  searchParams: Promise<{ draft?: string }>;
}) {
  const { botId } = await params;
  const { draft } = await searchParams;
  return <BotEdit botId={botId} draftId={UUID.test(draft ?? "") ? draft : undefined} />;
}
