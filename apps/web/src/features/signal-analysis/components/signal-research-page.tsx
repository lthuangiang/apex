"use client";

import { UserRole } from "@drift/shared";
import { Globe } from "lucide-react";
import { notFound } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";

import { PageHead, Workspace } from "@/components/workspace";
import { browserTimeZone, offsetLabel, offsetMinutes } from "@/features/account/market-hours-time";
import { BetaChip } from "@/features/bots/components/beta-chip";
import { useFeatures, useMe } from "@/lib/queries";

import { ResearchAudienceContext, type ResearchAudience } from "../research/audience";
import { ResearchExport } from "../research/research-export";
import { ResearchTab } from "../research/research-tab";

import type { PageCtx } from "./page-ctx";

// Signal Research BETA trên menu chính (#423; mockup docs/mockups/signal-research/menu-beta.html). Route ngoài /admin, dùng
// lại đúng tab Signal research của team (ResearchTab và mọi component con). Chỉ team và tài khoản team bật cờ
// `users.signal_research` (Users › Signal Research) mới vào được; người khác nhận trang Not found. Người dùng test không
// thấy ô Claude cost (và mọi chi phí / token Claude), version của team chỉ xem, có My versions. API tự kiểm
// quyền và bỏ dữ liệu chỉ team; trang này chỉ chọn người xem cho các component.

export function SignalResearchPage() {
  const t = useTranslations("signalResearch");
  const ts = useTranslations("signalAnalysis");
  const features = useFeatures();
  const me = useMe();
  const [browserTz, setBrowserTz] = useState<string | null>(null);
  const [utc, setUtc] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  useEffect(() => {
    setBrowserTz(browserTimeZone());
  }, []);
  const tzLocal = browserTz ?? "UTC";
  const tz = utc ? "UTC" : tzLocal;
  const offset = useMemo(() => offsetMinutes(tzLocal, new Date()), [tzLocal]);

  // Cờ tắt (hoặc API từ chối giữa chừng vì team vừa tắt cờ): trang Not found như route không có.
  if ((features.data !== undefined && !features.data.signalResearch) || forbidden) notFound();

  const audience: ResearchAudience | null =
    me.data === undefined ? null : me.data.role === UserRole.team ? "team" : "tester";
  const ready = browserTz !== null && features.data?.signalResearch === true;
  const ctx: PageCtx = {
    tz,
    utc,
    onMeta: () => undefined,
    onForbidden: () => {
      setForbidden(true);
    },
  };

  return (
    <Workspace current="signalResearch">
      <div className="flex flex-col gap-3">
        <PageHead
          title={t("title")}
          badge={<BetaChip bare />}
          subtitle={t("lede")}
          action={
            <div className="flex flex-wrap items-start gap-2.5">
              {/* #489: Export data chỉ cho team (API cũng chỉ trả cho team). */}
              {audience === "team" ? <ResearchExport /> : null}
              <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-control bg-surface-2 py-1 pr-1 pl-3 text-[12.5px] font-bold">
                <Globe aria-hidden="true" size={15} />
                <span>
                  {utc ? ts("tzUtc") : ts("tzLocal", { tz: tzLocal, offset: offsetLabel(offset) })}
                </span>
                <button
                  type="button"
                  aria-pressed={utc}
                  onClick={() => {
                    setUtc((x) => !x);
                  }}
                  className="min-h-11 cursor-pointer rounded-[9px] border border-border-input bg-surface px-3 text-[12.5px] font-bold text-ink"
                >
                  {utc ? ts("showLocal") : ts("showUtc")}
                </button>
              </div>
            </div>
          }
        />
        {ready && audience !== null ? (
          <ResearchAudienceContext.Provider value={audience}>
            <div className="flex min-w-0 flex-col gap-3">
              <ResearchTab ctx={ctx} />
            </div>
          </ResearchAudienceContext.Provider>
        ) : null}
      </div>
    </Workspace>
  );
}
