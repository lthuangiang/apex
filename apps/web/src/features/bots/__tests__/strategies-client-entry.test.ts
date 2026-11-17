import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as client from "@drift/strategies/client";
import { describe, expect, it } from "vitest";


// `@drift/strategies/client` (packages/strategies/src/client.ts) đi vào bundle trình duyệt (chunk tĩnh ai cũng tải được). Test này đi theo mọi import
// (kể cả gián tiếp) từ `client.ts` và chỉ cho phép schema, hằng số và hàm hiển thị thuần: không module logic bước nào.

const SRC = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../../packages/strategies/src",
);

const ALLOWED = [
  /^client\.ts$/,
  /^schemas\.ts$/,
  /^[a-z-]+\/schema\.ts$/,
  /^common\/(dca-math|grid|perps|schema|entry)\.ts$/,
  /^core\/(rounding|types)\.ts$/,
  /^recurring-buy\/schedule\.ts$/,
  /^rebalancing\/constants\.ts$/,
];

/** Import giá trị (bỏ `import type`) tới file nội bộ của package. */
function localImports(file: string): string[] {
  const src = readFileSync(file, "utf8");
  const out: string[] = [];
  for (const m of src.matchAll(/^(?:import|export)\s+(type\s+)?[^;]*?from\s+"(\.[^"]+)";/gms)) {
    if (m[1] !== undefined) continue;
    const spec = m[2];
    if (spec === undefined) continue;
    out.push(resolve(dirname(file), spec.endsWith(".ts") ? spec : `${spec}.ts`));
  }
  return out;
}

function graph(entry: string): string[] {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const f = stack.pop();
    if (f === undefined || seen.has(f)) continue;
    seen.add(f);
    stack.push(...localImports(f));
  }
  return [...seen].map((f) => relative(SRC, f)).sort();
}

describe("@drift/strategies/client", () => {
  it("imports only schemas, constants and pure display helpers", () => {
    const files = graph(join(SRC, "client.ts"));
    const offending = files.filter((f) => !ALLOWED.some((re) => re.test(f)));
    expect(offending).toEqual([]);
    expect(files).toContain("schemas.ts");
  });

  it("exports no strategy module or step function", () => {
    const names = Object.keys(client);
    for (const banned of [
      "STRATEGIES",
      "volumeFarm",
      "stepVolumeFarm",
      "farmSignal",
      "volumeMaker",
      "copyTrade",
      "adaptiveDca",
      "rebalancing",
      "twap",
    ]) {
      expect(names).not.toContain(banned);
    }
  });
});
