import { isProblemCall } from "@drift/shared";

import type { SodexCallCapture, SodexCallRecorderLike } from "./capture";
import { captureOutcome, toSodexCallRow, type SodexCallRow } from "./classify";

// Recorder của SoDEX Debugger (DEC-TBD-sodex-debugger). Yêu cầu: không bao giờ chặn hay làm chậm việc gửi lệnh.
// - `record` chỉ đẩy object vào hàng đợi trong bộ nhớ, không parse, không I/O, không ném. Hàng đợi giới hạn theo SỐ
//   bản ghi (50 000) VÀ theo dung lượng ước tính (64 MB, body đã cắt ở client).
// - Mỗi giây một lần flush: phân loại + che dữ liệu bằng regex (không parse JSON), nhường event loop mỗi khi một lát
//   chạy quá `sliceBudgetMs` (mặc định 2 ms) — review PR #217 B2. Chỉ một flush chạy cùng lúc; sink treo thì hết hạn
//   sau `flushTimeoutMs`.
// - Đầy: bỏ bản ghi thành công trước; bản ghi lỗi chỉ bị bỏ khi cả hàng đợi toàn là lỗi. Ghi lỗi: bản ghi lỗi được
//   thử lại tối đa `maxAttempts` lần rồi bỏ (có đếm), để một dòng hỏng không chặn recorder mãi (M2). Sau khi ghi lỗi,
//   nghỉ dần (backoff tới 60 s) để DB đang chậm không bị gọi mỗi giây. Cảnh báo có giới hạn tần suất (M6).

/** Ghi một batch. Có thể trả `{ dropped }`: số dòng DB từ chối vì dữ liệu hỏng (đã bỏ riêng từng dòng). */
export type SodexCallSink = (rows: SodexCallRow[]) => Promise<unknown>;

function droppedOf(result: unknown): number {
  if (result === null || typeof result !== "object" || !("dropped" in result)) return 0;
  const n = result.dropped;
  return typeof n === "number" ? n : 0;
}

export interface RecorderLog {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface SodexCallRecorderOptions {
  service: string;
  sink: SodexCallSink;
  /** Số bản ghi tối đa chờ ghi trong bộ nhớ. */
  capacity?: number;
  /** Dung lượng ước tính tối đa (byte) của hàng đợi. */
  maxBytes?: number;
  flushIntervalMs?: number;
  batchSize?: number;
  flushTimeoutMs?: number;
  /** Thời gian chạy liền tối đa của một lát phân loại trước khi nhường event loop. */
  sliceBudgetMs?: number;
  /** Số lần thử ghi một bản ghi lỗi trước khi bỏ. */
  maxAttempts?: number;
  log?: RecorderLog;
  /** Khoảng giữa hai log cảnh báo "đang bỏ bản ghi". */
  warnEveryMs?: number;
  /** Khoảng giữa hai log cảnh báo "ghi lỗi". */
  failWarnEveryMs?: number;
  /** Gọi sau khi ghi nốt ở `close()` (đóng pool DB riêng). */
  onClose?: () => Promise<void>;
}

export const RECORDER_DEFAULTS = {
  capacity: 50_000,
  maxBytes: 64 * 1024 * 1024,
  flushIntervalMs: 1_000,
  batchSize: 2_000,
  flushTimeoutMs: 30_000,
  sliceBudgetMs: 2,
  maxAttempts: 3,
  warnEveryMs: 10_000,
  failWarnEveryMs: 60_000,
} as const;

/** Nghỉ tối đa sau các lần ghi lỗi liên tiếp. */
const MAX_BACKOFF_MS = 60_000;
/** Phần cố định ước tính cho mỗi bản ghi (object, header, ngữ cảnh). */
const RECORD_OVERHEAD = 1_024;

interface Entry {
  capture: SodexCallCapture;
  bytes: number;
  attempts: number;
}

/** Ước tính dung lượng (2 byte mỗi ký tự UTF-16 + phần cố định). Không duyệt chuỗi: O(1). */
function sizeOf(c: SodexCallCapture): number {
  const text =
    c.kind === "rest"
      ? (c.responseText?.length ?? 0) + (c.requestBody?.length ?? 0)
      : (c.response?.length ?? 0) + (c.request?.length ?? 0);
  return RECORD_OVERHEAD + 2 * text;
}

/** Lỗi hoặc chậm (giữ 14 ngày): quyết định cái gì bị bỏ khi đầy. Không parse. */
export function likelyProblem(c: SodexCallCapture): boolean {
  return isProblemCall(captureOutcome(c), c.latencyMs);
}

const yieldToLoop = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

export class SodexCallRecorder implements SodexCallRecorderLike {
  readonly #service: string;
  readonly #sink: SodexCallSink;
  readonly #capacity: number;
  readonly #maxBytes: number;
  readonly #batchSize: number;
  readonly #flushTimeoutMs: number;
  readonly #sliceBudgetMs: number;
  readonly #maxAttempts: number;
  readonly #warnEveryMs: number;
  readonly #failWarnEveryMs: number;
  readonly #log: RecorderLog | undefined;
  readonly #timer: ReturnType<typeof setInterval>;
  readonly #onClose: (() => Promise<void>) | undefined;

  #ok: Entry[] = [];
  #problem: Entry[] = [];
  #bytes = 0;
  #flushing: Promise<void> | null = null;
  #droppedOk = 0;
  #droppedProblem = 0;
  /** Dòng sink bỏ riêng vì dữ liệu hỏng. */
  #droppedBad = 0;
  #writeFailures = 0;
  #lastWarn = 0;
  #lastFailWarn = 0;
  #failStreak = 0;
  #nextWriteAt = 0;
  #maxSliceMs = 0;
  #closed = false;

  constructor(options: SodexCallRecorderOptions) {
    this.#service = options.service;
    this.#sink = options.sink;
    this.#capacity = options.capacity ?? RECORDER_DEFAULTS.capacity;
    this.#maxBytes = options.maxBytes ?? RECORDER_DEFAULTS.maxBytes;
    this.#batchSize = options.batchSize ?? RECORDER_DEFAULTS.batchSize;
    this.#flushTimeoutMs = options.flushTimeoutMs ?? RECORDER_DEFAULTS.flushTimeoutMs;
    this.#sliceBudgetMs = options.sliceBudgetMs ?? RECORDER_DEFAULTS.sliceBudgetMs;
    this.#maxAttempts = options.maxAttempts ?? RECORDER_DEFAULTS.maxAttempts;
    this.#warnEveryMs = options.warnEveryMs ?? RECORDER_DEFAULTS.warnEveryMs;
    this.#failWarnEveryMs = options.failWarnEveryMs ?? RECORDER_DEFAULTS.failWarnEveryMs;
    this.#log = options.log;
    this.#onClose = options.onClose;
    this.#timer = setInterval(() => {
      void this.flush();
    }, options.flushIntervalMs ?? RECORDER_DEFAULTS.flushIntervalMs);
    this.#timer.unref();
  }

  get queued(): number {
    return this.#ok.length + this.#problem.length;
  }

  get queuedBytes(): number {
    return this.#bytes;
  }

  get dropped(): { ok: number; problem: number; bad: number } {
    return { ok: this.#droppedOk, problem: this.#droppedProblem, bad: this.#droppedBad };
  }

  /** Lát phân loại dài nhất (ms) kể từ khi tạo: test hiệu năng. */
  get maxSliceMs(): number {
    return this.#maxSliceMs;
  }

  #full(extraBytes: number): boolean {
    return this.queued >= this.#capacity || this.#bytes + extraBytes > this.#maxBytes;
  }

  #push(list: Entry[], entry: Entry): void {
    list.push(entry);
    this.#bytes += entry.bytes;
  }

  #popOk(): void {
    const e = this.#ok.pop();
    if (e !== undefined) {
      this.#bytes -= e.bytes;
      this.#droppedOk += 1;
    }
  }

  record(capture: SodexCallCapture): void {
    if (this.#closed) return;
    const entry: Entry = { capture, bytes: sizeOf(capture), attempts: 0 };
    const problem = likelyProblem(capture);
    if (!this.#full(entry.bytes)) {
      this.#push(problem ? this.#problem : this.#ok, entry);
      return;
    }
    if (!problem) {
      this.#droppedOk += 1;
    } else {
      // Nhường chỗ cho lỗi: bỏ bản ghi thành công (mới nhất, O(1)) tới khi đủ chỗ.
      while (this.#ok.length > 0 && this.#full(entry.bytes)) this.#popOk();
      if (this.#full(entry.bytes)) this.#droppedProblem += 1;
      else this.#push(this.#problem, entry);
    }
    this.#warnDropping();
  }

  #warnDropping(): void {
    const now = Date.now();
    if (now - this.#lastWarn < this.#warnEveryMs) return;
    this.#lastWarn = now;
    this.#log?.warn(
      {
        service: this.#service,
        queued: this.queued,
        queuedBytes: this.#bytes,
        droppedOk: this.#droppedOk,
        droppedProblem: this.#droppedProblem,
      },
      "sodex debugger queue full: dropping records",
    );
  }

  /** Ghi một batch (lỗi trước). Gọi chồng thì trả về flush đang chạy. */
  flush(): Promise<void> {
    if (this.#flushing !== null) return this.#flushing;
    if (this.queued === 0 || Date.now() < this.#nextWriteAt) return Promise.resolve();
    const run = this.#flushLoop().finally(() => {
      this.#flushing = null;
    });
    this.#flushing = run;
    return run;
  }

  #take(list: Entry[], n: number): Entry[] {
    const out = list.splice(0, n);
    for (const e of out) this.#bytes -= e.bytes;
    return out;
  }

  async #flushLoop(): Promise<void> {
    for (;;) {
      const problems = this.#take(this.#problem, this.#batchSize);
      const oks = this.#take(this.#ok, this.#batchSize - problems.length);
      const batch = [...problems, ...oks];
      if (batch.length === 0) return;
      const rows: SodexCallRow[] = [];
      let sliceStart = performance.now();
      for (const entry of batch) {
        try {
          rows.push(toSodexCallRow(entry.capture, this.#service));
        } catch {
          // Bản ghi hỏng: bỏ riêng nó.
          this.#droppedBad += 1;
        }
        const spent = performance.now() - sliceStart;
        if (spent >= this.#sliceBudgetMs) {
          this.#maxSliceMs = Math.max(this.#maxSliceMs, spent);
          await yieldToLoop();
          sliceStart = performance.now();
        }
      }
      this.#maxSliceMs = Math.max(this.#maxSliceMs, performance.now() - sliceStart);
      const ok = await this.#write(rows);
      if (!ok) {
        // Ghi lỗi: thử lại bản ghi lỗi (tối đa maxAttempts lần), bỏ bản ghi thành công.
        for (const e of problems) {
          e.attempts += 1;
          if (e.attempts < this.#maxAttempts && !this.#full(e.bytes)) this.#push(this.#problem, e);
          else this.#droppedProblem += 1;
        }
        this.#droppedOk += oks.length;
        this.#failStreak += 1;
        this.#nextWriteAt =
          Date.now() + Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** Math.min(this.#failStreak, 6));
        return;
      }
      this.#failStreak = 0;
      this.#nextWriteAt = 0;
      if (this.queued < this.#batchSize) return;
    }
  }

  #warnWriteFailure(obj: Record<string, unknown>, msg: string): void {
    this.#writeFailures += 1;
    const now = Date.now();
    if (now - this.#lastFailWarn < this.#failWarnEveryMs) return;
    this.#lastFailWarn = now;
    this.#log?.warn({ service: this.#service, failures: this.#writeFailures, ...obj }, msg);
  }

  async #write(rows: SodexCallRow[]): Promise<boolean> {
    if (rows.length === 0) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => {
        resolve("timeout");
      }, this.#flushTimeoutMs);
      timer.unref();
    });
    try {
      const result = await Promise.race([this.#sink(rows), timeout]);
      if (result === "timeout") {
        this.#warnWriteFailure({ rows: rows.length }, "sodex debugger write timed out");
        return false;
      }
      const bad = droppedOf(result);
      if (bad > 0) {
        this.#droppedBad += bad;
        this.#warnWriteFailure(
          { rows: rows.length, droppedBad: this.#droppedBad },
          "sodex debugger dropped rows the database refused",
        );
      }
      return true;
    } catch (error) {
      this.#warnWriteFailure({ rows: rows.length, err: error }, "sodex debugger write failed");
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /** SIGTERM: ngừng nhận, ghi nốt trong tối đa `timeoutMs`. */
  async close(timeoutMs = 5_000): Promise<void> {
    this.#closed = true;
    clearInterval(this.#timer);
    this.#nextWriteAt = 0;
    await Promise.race([
      (async () => {
        await this.#flushing;
        await this.flush();
      })(),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs).unref()),
    ]);
    await this.#onClose?.().catch(() => undefined);
  }
}

/** Công tắc tắt khẩn cấp: `SODEX_DEBUGGER=off` thì service không ghi lời gọi SoDEX nào. */
export function sodexDebuggerEnabled(env: Record<string, string | undefined>): boolean {
  return env.SODEX_DEBUGGER !== "off";
}

/**
 * Tạo recorder cho một service (undefined khi tắt bằng `SODEX_DEBUGGER=off`). `sink` là factory để không mở pool DB
 * khi tắt; `close()` của recorder đóng luôn sink.
 */
export function createSodexCallRecorder(input: {
  service: string;
  env: Record<string, string | undefined>;
  log?: RecorderLog;
  sink: () => {
    write: SodexCallSink;
    close: () => Promise<void>;
  };
}): SodexCallRecorder | undefined {
  if (!sodexDebuggerEnabled(input.env)) return undefined;
  const sink = input.sink();
  return new SodexCallRecorder({
    service: input.service,
    sink: (rows) => sink.write(rows),
    onClose: sink.close,
    ...(input.log === undefined ? {} : { log: input.log }),
  });
}
