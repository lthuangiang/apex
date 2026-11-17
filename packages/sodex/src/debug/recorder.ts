import { SODEX_CALL_SLOW_MS } from "@drift/shared";

import type { SodexCallCapture, SodexCallRecorderLike } from "./capture";
import { toSodexCallRow, type SodexCallRow } from "./classify";

// Recorder của SoDEX Debugger (DEC-TBD-sodex-debugger). Yêu cầu: không bao giờ chặn hay làm chậm việc gửi lệnh.
// - `record` chỉ đẩy object vào hàng đợi trong bộ nhớ (có giới hạn), không parse, không I/O, không ném.
// - Mỗi giây một lần flush: phân loại + che dữ liệu theo từng lát nhỏ (nhường event loop giữa các lát) rồi ghi batch
//   bằng `sink`. Chỉ một flush chạy cùng lúc; sink treo thì hết hạn sau `flushTimeoutMs` và hàng đợi cứ đầy rồi bỏ bớt.
// - Hàng đợi đầy: bỏ bản ghi thành công trước; bản ghi lỗi chỉ bị bỏ khi cả hàng đợi toàn là lỗi. Có log cảnh báo.

export type SodexCallSink = (rows: SodexCallRow[]) => Promise<void>;

export interface RecorderLog {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface SodexCallRecorderOptions {
  service: string;
  sink: SodexCallSink;
  /** Số bản ghi tối đa chờ ghi trong bộ nhớ. */
  capacity?: number;
  flushIntervalMs?: number;
  batchSize?: number;
  flushTimeoutMs?: number;
  log?: RecorderLog;
  /** Khoảng giữa hai log cảnh báo "đang bỏ bản ghi". */
  warnEveryMs?: number;
  /** Gọi sau khi ghi nốt ở `close()` (đóng pool DB riêng). */
  onClose?: () => Promise<void>;
}

export const RECORDER_DEFAULTS = {
  capacity: 50_000,
  flushIntervalMs: 1_000,
  batchSize: 2_000,
  flushTimeoutMs: 30_000,
  warnEveryMs: 10_000,
} as const;

/** Số bản ghi phân loại trong một lát trước khi nhường event loop. */
const SLICE = 50;

/**
 * Đoán nhanh (không parse) bản ghi có phải lỗi / chậm không, để quyết định bỏ gì khi hàng đợi đầy. Phân loại chính
 * xác làm lúc flush.
 */
export function likelyProblem(c: SodexCallCapture): boolean {
  if (c.latencyMs > SODEX_CALL_SLOW_MS) return true;
  if (c.kind === "ws") return c.outcome !== "ok";
  if (c.failure !== null || c.schemaOk === false) return true;
  const status = c.httpStatus ?? 0;
  if (status < 200 || status >= 300) return true;
  const text = c.responseText ?? "";
  return !text.startsWith('{"code":0') || text.includes('"code":-');
}

const yieldToLoop = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

export class SodexCallRecorder implements SodexCallRecorderLike {
  readonly #service: string;
  readonly #sink: SodexCallSink;
  readonly #capacity: number;
  readonly #batchSize: number;
  readonly #flushTimeoutMs: number;
  readonly #warnEveryMs: number;
  readonly #log: RecorderLog | undefined;
  readonly #timer: ReturnType<typeof setInterval>;
  readonly #onClose: (() => Promise<void>) | undefined;

  #ok: SodexCallCapture[] = [];
  #problem: SodexCallCapture[] = [];
  #flushing: Promise<void> | null = null;
  #droppedOk = 0;
  #droppedProblem = 0;
  #lastWarn = 0;
  #closed = false;

  constructor(options: SodexCallRecorderOptions) {
    this.#service = options.service;
    this.#sink = options.sink;
    this.#capacity = options.capacity ?? RECORDER_DEFAULTS.capacity;
    this.#batchSize = options.batchSize ?? RECORDER_DEFAULTS.batchSize;
    this.#flushTimeoutMs = options.flushTimeoutMs ?? RECORDER_DEFAULTS.flushTimeoutMs;
    this.#warnEveryMs = options.warnEveryMs ?? RECORDER_DEFAULTS.warnEveryMs;
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

  get dropped(): { ok: number; problem: number } {
    return { ok: this.#droppedOk, problem: this.#droppedProblem };
  }

  record(capture: SodexCallCapture): void {
    if (this.#closed) return;
    const problem = likelyProblem(capture);
    if (this.queued < this.#capacity) {
      (problem ? this.#problem : this.#ok).push(capture);
      return;
    }
    if (!problem) {
      this.#droppedOk += 1;
    } else if (this.#ok.length > 0) {
      // Nhường chỗ cho lỗi: bỏ một bản ghi thành công (mới nhất, O(1)).
      this.#ok.pop();
      this.#droppedOk += 1;
      this.#problem.push(capture);
    } else {
      this.#droppedProblem += 1;
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
        droppedOk: this.#droppedOk,
        droppedProblem: this.#droppedProblem,
      },
      "sodex debugger queue full: dropping records",
    );
  }

  /** Ghi một batch (lỗi trước). Gọi chồng thì trả về flush đang chạy. */
  flush(): Promise<void> {
    if (this.#flushing !== null) return this.#flushing;
    if (this.queued === 0) return Promise.resolve();
    const run = this.#flushLoop().finally(() => {
      this.#flushing = null;
    });
    this.#flushing = run;
    return run;
  }

  async #flushLoop(): Promise<void> {
    for (;;) {
      const problems = this.#problem.splice(0, this.#batchSize);
      const oks = this.#ok.splice(0, this.#batchSize - problems.length);
      const batch = [...problems, ...oks];
      if (batch.length === 0) return;
      const rows: SodexCallRow[] = [];
      for (let i = 0; i < batch.length; i += 1) {
        const capture = batch[i];
        if (capture === undefined) continue;
        try {
          rows.push(toSodexCallRow(capture, this.#service));
        } catch {
          // Bản ghi hỏng: bỏ riêng nó.
        }
        if ((i + 1) % SLICE === 0) await yieldToLoop();
      }
      const ok = await this.#write(rows);
      if (!ok) {
        // Ghi lỗi: giữ lại các bản ghi lỗi nếu còn chỗ (thành công thì bỏ), thử lại ở nhịp sau.
        for (const c of problems) {
          if (this.queued < this.#capacity) this.#problem.push(c);
          else this.#droppedProblem += 1;
        }
        this.#droppedOk += oks.length;
        return;
      }
      if (this.queued < this.#batchSize) return;
    }
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
      const result = await Promise.race([this.#sink(rows).then(() => "done" as const), timeout]);
      if (result === "timeout") {
        this.#log?.warn(
          { service: this.#service, rows: rows.length },
          "sodex debugger write timed out",
        );
        return false;
      }
      return true;
    } catch (error) {
      this.#log?.warn(
        { service: this.#service, rows: rows.length, err: error },
        "sodex debugger write failed",
      );
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /** SIGTERM: ngừng nhận, ghi nốt trong tối đa `timeoutMs`. */
  async close(timeoutMs = 5_000): Promise<void> {
    this.#closed = true;
    clearInterval(this.#timer);
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
  sink: () => { write: SodexCallSink; close: () => Promise<void> };
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
