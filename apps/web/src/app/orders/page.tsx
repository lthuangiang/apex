import { OrdersPage } from "@/features/bots";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ botId?: string }>;
}) {
  const { botId } = await searchParams;
  return <OrdersPage {...(botId === undefined ? {} : { botId })} />;
}
