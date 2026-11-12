import { Suspense } from "react";

import { TradersPage } from "@/features/copy";

export default function Page() {
  return (
    <Suspense>
      <TradersPage />
    </Suspense>
  );
}
