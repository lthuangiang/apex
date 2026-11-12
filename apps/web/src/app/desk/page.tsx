import { Suspense } from "react";

import { DeskPage } from "@/features/desk";

export default function Page() {
  return (
    <Suspense>
      <DeskPage />
    </Suspense>
  );
}
