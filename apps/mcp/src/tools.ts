import { z } from "zod";

import { reasonCodeInfo } from "./reason-codes";
import type { ToolDef } from "./server";

// Danh mục tool (docs/MCP.md mục 5). A2 có tool nội bộ đầu tiên (`team_reason_code`, dữ liệu tĩnh) để chạy hết đường đi
// OAuth → MCP → nhật ký; A3 thêm các tool `team_*` đọc dữ liệu qua api. Mỗi kết quả có `asOf` và `source`.

export const TOOLS: readonly ToolDef[] = [
  {
    name: "team_reason_code",
    endpoint: "team",
    scope: "team:read",
    title: "Explain a reason code",
    description:
      "Read-only. What a DeskLabs bot reason code (why a bot paused or stopped) means and when the bot can resume.",
    input: { code: z.string().min(1).max(40).describe("Reason code, for example RISK_DAILY_LOSS") },
    run(ctx, args) {
      const info = reasonCodeInfo(String(args.code).trim().toUpperCase());
      return Promise.resolve(
        info === null
          ? {
              code: String(args.code),
              info: null,
              reason: "unknown_code",
              asOf: ctx.now().toISOString(),
            }
          : { ...info, asOf: ctx.now().toISOString() },
      );
    },
  },
];
