import { GoalsForm } from "@/features/onboarding";

export default async function Page({ searchParams }: { searchParams: Promise<{ from?: string }> }) {
  const { from } = await searchParams;
  return <GoalsForm returnTo={from === "desk" ? "/desk" : undefined} />;
}
