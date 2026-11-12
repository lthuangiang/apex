import { DeepAnalytics } from "@/features/bots";

// Deep Analytics của một bot (DEC-141).
export default async function Page({ params }: { params: Promise<{ botId: string }> }) {
  const { botId } = await params;
  return <DeepAnalytics botId={botId} />;
}
