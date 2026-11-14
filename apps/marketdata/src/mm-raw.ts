import { appendFile, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

// Lưu thô bookTicker + trade của các market đang nghe (DEC-228), để sau này mô phỏng bot Market Making
// (replay) và kiểm chứng với bot thật. Mỗi giờ (UTC) một file `YYYY-MM-DDTHH.ndjson.gz`. Cứ vài giây nén phần đệm
// thành một gzip member rồi nối vào cuối file: nhiều member nối nhau vẫn là gzip hợp lệ (`zcat` đọc được), dừng đột
// ngột chỉ mất phần chưa ghi. Giữ 48 giờ. Mỗi dòng:
//   {"k":"b","s":market,"r":giờ nhận ms,"E":giờ SoDEX ms,"b","B","a","A"}  (best bid / ask và size)
//   {"k":"t","s":market,"r":giờ nhận ms,"T":giờ khớp ms,"i":trade id,"S":phía taker,"p","q"}

export const MM_RAW_KEEP_MS = 48 * 3_600_000;
const HOUR = 3_600_000;
const FILE = /^(\d{4}-\d{2}-\d{2}T\d{2})\.ndjson\.gz$/;

export const rawFileOf = (at: number) => `${new Date(at).toISOString().slice(0, 13)}.ndjson.gz`;

export class MmRawRecorder {
  readonly #dir: string;
  /** Dòng chờ ghi theo file giờ. */
  #pending = new Map<string, string[]>();
  #ready: Promise<unknown> | null = null;

  constructor(dir: string) {
    this.#dir = dir;
  }

  book(t: { s: string; E: number; b: string; B: string; a: string; A: string }, at: number): void {
    this.#push(at, { k: "b", s: t.s, r: at, E: t.E, b: t.b, B: t.B, a: t.a, A: t.A });
  }

  trade(
    t: { s: string; T: number; t?: number | string | undefined; S: string; p: string; q: string },
    at: number,
  ): void {
    this.#push(at, { k: "t", s: t.s, r: at, T: t.T, i: t.t ?? null, S: t.S, p: t.p, q: t.q });
  }

  /** Nén phần đệm và nối vào file của từng giờ. Trả về số dòng đã ghi. */
  async flush(): Promise<number> {
    if (this.#pending.size === 0) return 0;
    const batch = this.#pending;
    this.#pending = new Map();
    this.#ready ??= mkdir(this.#dir, { recursive: true });
    await this.#ready;
    let n = 0;
    for (const [file, lines] of batch) {
      await appendFile(join(this.#dir, file), gzipSync(`${lines.join("\n")}\n`));
      n += lines.length;
    }
    return n;
  }

  /** Xoá file của giờ đã quá `MM_RAW_KEEP_MS`. Trả về số file đã xoá. */
  async purge(now: number): Promise<number> {
    let names: string[];
    try {
      names = await readdir(this.#dir);
    } catch {
      return 0;
    }
    let n = 0;
    for (const name of names) {
      const m = FILE.exec(name);
      if (m === null) continue;
      const hour = Date.parse(`${m[1] ?? ""}:00:00Z`);
      if (Number.isFinite(hour) && hour + HOUR <= now - MM_RAW_KEEP_MS) {
        await rm(join(this.#dir, name), { force: true });
        n += 1;
      }
    }
    return n;
  }

  #push(at: number, row: Record<string, unknown>): void {
    const file = rawFileOf(at);
    const list = this.#pending.get(file) ?? [];
    list.push(JSON.stringify(row));
    this.#pending.set(file, list);
  }
}
