import {
  AckPolicy,
  DeliverPolicy,
  jetstream,
  jetstreamManager,
  RetentionPolicy,
  type JetStreamClient,
} from "@nats-io/jetstream";
import type { NatsConnection } from "@nats-io/transport-node";

// Work queue trên JetStream (ARCHITECTURE.md mục 3.3.5): `jobs.*` (stream JOBS) và `backtest.run`
// (stream BACKTEST). Ack sau khi xong; retry backoff tối đa 5 lần rồi chuyển `jobs.dlq.<subject>`.

export const JOBS_STREAM = "JOBS";
export const BACKTEST_STREAM = "BACKTEST";
export const DLQ_STREAM = "JOBS_DLQ";
/** Subject đi qua JetStream; mọi topic outbox khác là NATS thường. */
export const isQueueSubject = (topic: string) =>
  topic.startsWith("jobs.") || topic === "backtest.run";
const streamOf = (subject: string) =>
  subject.startsWith("backtest.") ? BACKTEST_STREAM : JOBS_STREAM;
export const MAX_DELIVER = 5;
export const BACKOFF_MS = [1_000, 5_000, 30_000, 120_000, 600_000];

export async function ensureStreams(nc: NatsConnection): Promise<JetStreamClient> {
  const jsm = await jetstreamManager(nc);
  const streams = await jsm.streams.names().next();
  if (!streams.includes(JOBS_STREAM)) {
    await jsm.streams.add({
      name: JOBS_STREAM,
      subjects: ["jobs.*"],
      retention: RetentionPolicy.Workqueue,
    });
  }
  if (!streams.includes(BACKTEST_STREAM)) {
    await jsm.streams.add({
      name: BACKTEST_STREAM,
      subjects: ["backtest.run"],
      retention: RetentionPolicy.Workqueue,
    });
  }
  if (!streams.includes(DLQ_STREAM)) {
    await jsm.streams.add({ name: DLQ_STREAM, subjects: ["jobs.dlq.>"] });
  }
  return jetstream(nc);
}

export async function ensureConsumer(
  nc: NatsConnection,
  name: string,
  subject: string,
  /** Consumer dùng `DeferError` cần nhiều lượt giao hơn (mỗi lần hoãn cũng tính một lượt). */
  options: { maxDeliver?: number } = {},
): Promise<void> {
  const jsm = await jetstreamManager(nc);
  try {
    await jsm.consumers.info(streamOf(subject), name);
  } catch {
    await jsm.consumers.add(streamOf(subject), {
      durable_name: name,
      filter_subject: subject,
      ack_policy: AckPolicy.Explicit,
      deliver_policy: DeliverPolicy.All,
      max_deliver: options.maxDeliver ?? MAX_DELIVER,
      ack_wait: 15 * 60 * 1_000_000_000,
    });
  }
}

/**
 * Chưa tới lúc xử lý (cửa sổ gom tin, giới hạn tốc độ, `retry_after`): message được giao lại sau `delayMs`, không
 * tính là lỗi và không chặn các message khác của consumer trong lúc chờ.
 */
export class DeferError extends Error {
  constructor(readonly delayMs: number) {
    super(`deferred ${String(delayMs)} ms`);
    this.name = "DeferError";
  }
}

export interface ConsumeOptions {
  /** Phải khớp `maxDeliver` của consumer. Mặc định MAX_DELIVER. */
  maxDeliver?: number;
  /** Gọi trước khi đẩy message vào DLQ (ví dụ đánh dấu `failed` trong DB). */
  onDeadLetter?: (payload: unknown) => Promise<void>;
}

/** Xử lý message một cách idempotent; lỗi thì nak với backoff, hết lượt thì đẩy vào DLQ. */
export async function consume(
  js: JetStreamClient,
  name: string,
  subject: string,
  handle: (payload: unknown) => Promise<void>,
  log: (msg: string, extra: Record<string, unknown>) => void,
  options: ConsumeOptions = {},
): Promise<() => Promise<void>> {
  const consumer = await js.consumers.get(streamOf(subject), name);
  const messages = await consumer.consume();
  const maxDeliver = options.maxDeliver ?? MAX_DELIVER;
  const loop = (async () => {
    for await (const m of messages) {
      const attempt = m.info.deliveryCount;
      try {
        await handle(m.json());
        m.ack();
      } catch (error) {
        if (error instanceof DeferError && attempt < maxDeliver) {
          m.nak(Math.max(0, error.delayMs));
          continue;
        }
        log("job failed", {
          consumer: name,
          attempt,
          error: error instanceof Error ? error.message : String(error),
        });
        if (attempt >= maxDeliver) {
          await options.onDeadLetter?.(m.json()).catch(() => undefined);
          await js.publish(`jobs.dlq.${m.subject}`, m.data);
          m.term();
        } else {
          m.nak(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length) - 1] ?? 600_000);
        }
      }
    }
  })();
  return async () => {
    messages.stop();
    await loop;
  };
}
