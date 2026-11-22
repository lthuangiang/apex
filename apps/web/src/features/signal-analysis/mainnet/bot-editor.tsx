"use client";

import { ErrorCode, type ResearchVersion } from "@drift/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { ApiError } from "@/lib/api";
import { useSodexConnection, useTwoFactorNeeded } from "@/lib/queries";

import { useResearchMarkets } from "../research/api";
import { VersionSheet } from "../research/version-sheet";

import { NEWS_BOTS_KEY, useCreateNewsBot, useNewsBotAction, useNewsBotChecks } from "./api";
import { useMainnetErrorText } from "./text";

// "Start bot from a version" (#421, PM chốt (b)): dùng lại version editor, thêm các ô của bot mainnet. Một nút "Start bot"
// = tạo bot (draft) rồi Start ngay. Start bị từ chối (cờ tắt 409, kiểm tra, 2FA…) thì bot ở lại Draft, editor hiện lỗi /
// kết quả kiểm tra; lần bấm sau chỉ Start lại bot đó, không tạo bot thứ hai.

export function NewsBotEditor({
  from,
  versions,
  onClose,
  onStarted,
}: {
  from: ResearchVersion;
  versions: readonly ResearchVersion[];
  onClose: () => void;
  /** Bot đã tạo (kể cả khi Start chưa qua): trang chọn bot đó. */
  onStarted: (botId: string) => void;
}) {
  const qc = useQueryClient();
  const [source, setSource] = useState(from);
  const [botId, setBotId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [needCode, setNeedCode] = useState(false);
  const twoFactorNeeded = useTwoFactorNeeded();
  const conn = useSodexConnection();
  const markets = useResearchMarkets(true);
  const create = useCreateNewsBot();
  const errorText = useMainnetErrorText();
  const checks = useNewsBotChecks(botId, error !== null);
  const start = useNewsBotAction();
  const c = conn.data?.connection;
  const account =
    c?.status === "connected" ? (c.apiKey === null ? "••" : `••${c.apiKey.last4}`) : null;

  const startBot = (id: string) => {
    start.mutate(
      {
        id,
        action: "start",
        body: { acknowledged: true, ...(code.trim() === "" ? {} : { twoFactorCode: code.trim() }) },
      },
      {
        onSuccess: () => {
          onStarted(id);
          onClose();
        },
        onError: (e) => {
          if (e instanceof ApiError && e.code === ErrorCode.twoFactorRequired) setNeedCode(true);
          setError(errorText(e));
          void qc.invalidateQueries({ queryKey: [...NEWS_BOTS_KEY, id, "checks"] });
        },
      },
    );
  };

  return (
    <VersionSheet
      mode={{ kind: "bot", from: source }}
      next={0}
      running={0}
      maxRunning={1}
      markets={{
        data: markets.data,
        loading: markets.isPending && markets.fetchStatus !== "idle",
        error: markets.isError,
      }}
      pending={create.isPending || start.isPending}
      checking={create.checking || start.checking}
      error={error}
      onClose={onClose}
      onSave={() => undefined}
      bot={{
        versions,
        account,
        checks: error === null ? null : (checks.data ?? null),
        twoFactor: twoFactorNeeded || needCode ? { value: code, onChange: setCode } : null,
        onVersion: setSource,
        onStart: (input) => {
          setError(null);
          if (botId !== null) {
            startBot(botId);
            return;
          }
          create.mutate(input, {
            onSuccess: (b) => {
              setBotId(b.id);
              onStarted(b.id);
              startBot(b.id);
            },
            onError: (e) => {
              setError(errorText(e));
            },
          });
        },
      }}
    />
  );
}
