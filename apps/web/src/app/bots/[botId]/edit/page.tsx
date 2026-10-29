import { BotEdit } from "@/features/bots";

export default async function Page({ params }: { params: Promise<{ botId: string }> }) {
  const { botId } = await params;
  return <BotEdit botId={botId} />;
}
