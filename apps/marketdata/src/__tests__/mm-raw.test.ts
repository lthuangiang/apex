import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import { MmRawRecorder, rawFileOf } from "../mm-raw";

// Lưu thô bookTicker + trade (DEC-228): file gzip theo giờ UTC, nối nhiều lần vẫn đọc được, giữ 48 giờ.

let dir = "";
afterEach(async () => {
  if (dir !== "") await rm(dir, { recursive: true, force: true });
});

const H = Date.parse("2026-11-14T06:00:00Z");
const lines = async (file: string) =>
  gunzipSync(await readFile(join(dir, file)))
    .toString()
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);

describe("raw market data recorder", () => {
  it("appends gzip members to one file per UTC hour that read back as one stream", async () => {
    dir = await mkdtemp(join(tmpdir(), "mm-raw-"));
    const r = new MmRawRecorder(dir);
    r.book({ s: "ETH-USD", E: H + 1, b: "3000.1", B: "2", a: "3000.2", A: "1.5" }, H + 5);
    r.trade({ s: "ETH-USD", T: H + 6, t: 991, S: "BUY", p: "3000.2", q: "0.4" }, H + 9);
    expect(await r.flush()).toBe(2);
    r.trade({ s: "BTC-USD", T: H + 10, S: "SELL", p: "90000", q: "0.01" }, H + 12);
    r.book({ s: "ETH-USD", E: H + 3_600_000, b: "1", B: "1", a: "2", A: "1" }, H + 3_600_001);
    expect(await r.flush()).toBe(2);
    expect(await r.flush()).toBe(0);
    expect((await readdir(dir)).sort()).toEqual([
      "2026-11-14T06.ndjson.gz",
      "2026-11-14T07.ndjson.gz",
    ]);
    expect(await lines(rawFileOf(H))).toEqual([
      { k: "b", s: "ETH-USD", r: H + 5, E: H + 1, b: "3000.1", B: "2", a: "3000.2", A: "1.5" },
      { k: "t", s: "ETH-USD", r: H + 9, T: H + 6, i: 991, S: "BUY", p: "3000.2", q: "0.4" },
      { k: "t", s: "BTC-USD", r: H + 12, T: H + 10, i: null, S: "SELL", p: "90000", q: "0.01" },
    ]);
  });

  it("deletes hour files older than 48 hours and leaves other files alone", async () => {
    dir = await mkdtemp(join(tmpdir(), "mm-raw-"));
    for (const name of [
      "2026-11-12T05.ndjson.gz",
      "2026-11-12T06.ndjson.gz",
      "2026-11-14T06.ndjson.gz",
      "notes.txt",
    ])
      await writeFile(join(dir, name), "");
    const r = new MmRawRecorder(dir);
    // Bây giờ 06:30 ngày 14: giờ 05 ngày 12 đã hết hạn (kết thúc 06:00 ngày 12 ≤ 06:30 − 48 giờ), giờ 06 thì chưa.
    expect(await r.purge(H + 30 * 60_000)).toBe(1);
    expect((await readdir(dir)).sort()).toEqual([
      "2026-11-12T06.ndjson.gz",
      "2026-11-14T06.ndjson.gz",
      "notes.txt",
    ]);
    expect(await new MmRawRecorder(join(dir, "missing")).purge(H)).toBe(0);
  });
});
