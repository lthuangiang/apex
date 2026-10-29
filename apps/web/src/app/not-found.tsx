import { SESSION_COOKIE } from "@drift/shared";
import { cookies } from "next/headers";

import { NotFoundPage } from "@/features/public";

export default async function NotFound() {
  return <NotFoundPage signedIn={(await cookies()).has(SESSION_COOKIE)} />;
}
