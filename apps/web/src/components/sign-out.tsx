"use client";

import { Button } from "@drift/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useDisconnect } from "wagmi";
import { z } from "zod";

import { api } from "@/lib/api";

/**
 * Thu hồi phiên ở server (`DELETE /api/v1/auth/session`, có audit), ngắt kết nối ví trong trình duyệt, rồi
 * về trang đăng nhập. Không ngắt ví thì tài khoản DRIFT kế tiếp trên cùng trình duyệt dùng lại ví cũ.
 */
export function SignOutButton() {
  const t = useTranslations("common.nav");
  const qc = useQueryClient();
  const { mutateAsync: disconnectWallet } = useDisconnect();
  const signOut = useMutation({
    mutationFn: () =>
      api("DELETE", "/api/v1/auth/session", z.unknown(), { idempotencyKey: crypto.randomUUID() }),
    onSettled: async () => {
      qc.clear();
      await disconnectWallet().catch(() => undefined);
      window.location.assign("/signin");
    },
  });
  return (
    <Button
      variant="secondary"
      pending={signOut.isPending}
      onClick={() => {
        signOut.mutate();
      }}
    >
      {t("signOut")}
    </Button>
  );
}
