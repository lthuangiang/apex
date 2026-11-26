import {
  cybereatorProfileSchema,
  lotteryBoxesSchema,
  lotteryDrawEntriesSchema,
  lotteryFeedSchema,
  lotteryHistorySchema,
  lotteryJobSchema,
  lotteryJobsSchema,
  lotteryLedgerSchema,
  lotteryMetaSchema,
  lotteryPfpsSchema,
  lotteryTreasuresSchema,
  sopointsSummarySchema,
  sopointsVolumeWeightsSchema,
  sopointsWeekInfoSchema,
  sopointsWeekListSchema,
} from "@drift/shared";
import { z } from "zod";

import { RewardsError, rewardsRequest, type RewardsRequest } from "./client";
import { describeShape, type FieldRow } from "./shape";

// Các endpoint ĐỌC mà trang chẩn đoán gọi (#547). Không có endpoint ghi (claim / open / merge), không transfer.

export interface ProbeSpec {
  id: string;
  path: string;
  query?: Record<string, string | number | boolean>;
  auth: boolean;
  schema: z.ZodType;
  envelope?: boolean;
  groupBy?: string;
  /** Trường dạng enum cần liệt kê mọi giá trị khác nhau trong mảng (chỉ chuỗi / boolean / null, không số liệu). */
  enums?: readonly string[];
}

export const PROBES: readonly ProbeSpec[] = [
  { id: "sopoints/summary", path: "sopoints/summary", auth: true, schema: sopointsSummarySchema },
  {
    id: "sopoints/week/list",
    path: "sopoints/week/list",
    auth: true,
    schema: sopointsWeekListSchema,
    // Giá trị thật của hai loại tuần chưa chốt (In progress / Snapshot done), PM review 2026-11-26.
    enums: ["status", "pointsStatus", "isLive"],
  },
  {
    id: "sopoints/week/info",
    path: "sopoints/week/info",
    auth: false,
    schema: sopointsWeekInfoSchema,
  },
  {
    id: "sopoints/volume-weights",
    path: "sopoints/volume-weights",
    auth: false,
    schema: sopointsVolumeWeightsSchema,
  },
  { id: "lottery/meta", path: "lottery/meta", auth: false, schema: lotteryMetaSchema },
  {
    id: "lottery/treasures",
    path: "lottery/treasures",
    auth: true,
    schema: lotteryTreasuresSchema,
  },
  { id: "lottery/boxes", path: "lottery/boxes", auth: true, schema: lotteryBoxesSchema },
  {
    id: "lottery/jobs?active=true",
    path: "lottery/jobs",
    query: { active: true },
    auth: true,
    schema: lotteryJobsSchema,
  },
  {
    id: "lottery/ledger",
    path: "lottery/ledger",
    auth: true,
    schema: lotteryLedgerSchema,
    groupBy: "kind",
  },
  { id: "lottery/history", path: "lottery/history", auth: true, schema: lotteryHistorySchema },
  {
    id: "lottery/draw/entries",
    path: "lottery/draw/entries",
    auth: true,
    schema: lotteryDrawEntriesSchema,
  },
  { id: "lottery/pfps", path: "lottery/pfps", auth: true, schema: lotteryPfpsSchema },
  { id: "lottery/feed", path: "lottery/feed", auth: false, schema: lotteryFeedSchema },
];

/** Probe phụ thuộc dữ liệu: job gần nhất (nếu có) và PFP đầu tiên (nếu có). */
export function followUpProbes(results: readonly ProbeResult[]): ProbeSpec[] {
  const out: ProbeSpec[] = [];
  const jobs = results.find((r) => r.id === "lottery/jobs?active=true")?.data;
  const job = lotteryJobsSchema.safeParse(jobs);
  const firstJob = job.success ? job.data.jobs[0] : undefined;
  if (firstJob !== undefined)
    out.push({
      id: "lottery/job/{id}",
      path: `lottery/job/${String(firstJob.jobId)}`,
      auth: true,
      schema: lotteryJobSchema,
    });
  const pfps = lotteryPfpsSchema.safeParse(results.find((r) => r.id === "lottery/pfps")?.data);
  const firstPfp = pfps.success ? pfps.data.pfps[0] : undefined;
  if (firstPfp !== undefined)
    out.push({
      id: "cybereator/profile/{id}",
      path: `cybereator/profile/${String(firstPfp.profileTokenId)}`,
      auth: false,
      envelope: false,
      schema: cybereatorProfileSchema,
    });
  return out;
}

export interface ProbeResult {
  id: string;
  auth: boolean;
  outcome: "ok" | RewardsError["kind"];
  status: number;
  /** null = schema khớp; mảng = đường dẫn trường lệch. */
  schemaIssues: string[] | null;
  rows: FieldRow[] | null;
  sodexMessage: string | null;
  retryAfterSec: number | null;
  /** Giữ trong bộ nhớ để dựng probe phụ thuộc; không hiện nguyên. */
  data: unknown;
  /** Giá trị khác nhau của các trường enum (`ProbeSpec.enums`); null khi không yêu cầu. */
  enums: { field: string; values: string[] }[] | null;
}

/**
 * Mọi giá trị khác nhau của các trường enum trong một mảng object (ví dụ `week/list`): chỉ giữ chuỗi, boolean và
 * null / thiếu; số và object bỏ qua (không hiện số liệu). Chuỗi dài hoặc trông như địa chỉ / hash thì bỏ (không lộ dữ liệu).
 */
export function distinctEnumValues(
  data: unknown,
  fields: readonly string[],
): { field: string; values: string[] }[] {
  const rows = Array.isArray(data) ? data : [];
  return fields.map((field) => {
    const seen = new Set<string>();
    for (const row of rows) {
      if (typeof row !== "object" || row === null) continue;
      const v = (row as Record<string, unknown>)[field];
      if (v === undefined) seen.add("(missing)");
      else if (v === null) seen.add("null");
      else if (typeof v === "boolean") seen.add(String(v));
      else if (typeof v === "string" && v.length <= 40 && !/0x[0-9a-fA-F]{8,}/.test(v)) seen.add(v);
    }
    return { field, values: [...seen].sort() };
  });
}

type Caller = <T extends z.ZodType>(req: Omit<RewardsRequest<T>, "token">) => Promise<z.output<T>>;

export async function runProbe(
  spec: ProbeSpec,
  authed: Caller,
  pub: Caller = rewardsRequest,
): Promise<ProbeResult> {
  const call = spec.auth ? authed : pub;
  const base = { id: spec.id, auth: spec.auth };
  try {
    const data = await call({
      path: spec.path,
      schema: z.unknown(),
      ...(spec.query === undefined ? {} : { query: spec.query }),
      ...(spec.envelope === undefined ? {} : { envelope: spec.envelope }),
    });
    const check = spec.schema.safeParse(data);
    return {
      ...base,
      outcome: "ok",
      status: 200,
      schemaIssues: check.success
        ? null
        : check.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.code}`),
      rows: describeShape(data, spec.groupBy === undefined ? {} : { groupBy: spec.groupBy }),
      sodexMessage: null,
      retryAfterSec: null,
      data,
      enums: spec.enums === undefined ? null : distinctEnumValues(data, spec.enums),
    };
  } catch (e) {
    const err = e instanceof RewardsError ? e : new RewardsError("network", 0);
    return {
      ...base,
      outcome: err.kind,
      status: err.status,
      schemaIssues: null,
      rows: null,
      sodexMessage: err.sodexMessage,
      retryAfterSec: err.retryAfterSec,
      data: null,
      enums: null,
    };
  }
}

/** Gọi lần lượt (nhẹ cho rate limit); dừng khi hết hạn token hoặc bị 429. */
export async function runAllProbes(
  authed: Caller,
  onResult: (r: ProbeResult) => void,
  pub: Caller = rewardsRequest,
): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  const queue: ProbeSpec[] = [...PROBES];
  let followed = false;
  for (;;) {
    const spec = queue.shift();
    if (spec === undefined) {
      if (followed) break;
      followed = true;
      queue.push(...followUpProbes(results));
      continue;
    }
    const r = await runProbe(spec, authed, pub);
    results.push(r);
    onResult(r);
    if (r.outcome === "expired" || r.outcome === "rate_limited") break;
  }
  return results;
}
