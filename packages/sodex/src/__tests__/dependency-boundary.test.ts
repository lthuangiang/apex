import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// #336 (DEC-355): `@drift/sodex` không phụ thuộc DB, để cây dependency của signer (nơi giữ key),
// engine và marketdata nhỏ nhất có thể. Đối soát chữ ký (đọc SoDEX + ghi DB) nằm ở package riêng `@drift/sodex-reconcile`,
// chỉ api và jobs dùng. Test đọc package.json của workspace và đi hết cây `@drift/*` (kể cả gián tiếp).

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

interface Manifest {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function manifests(): Map<string, Manifest> {
  const out = new Map<string, Manifest>();
  for (const dir of ["apps", "packages"])
    for (const name of readdirSync(`${ROOT}${dir}`)) {
      let m: Manifest;
      try {
        m = JSON.parse(readFileSync(`${ROOT}${dir}/${name}/package.json`, "utf8")) as Manifest;
      } catch {
        continue;
      }
      out.set(m.name, m);
    }
  return out;
}

const all = manifests();

/** Các package `@drift/*` mà `name` phụ thuộc lúc chạy (dependencies, kể cả gián tiếp). */
function runtimeDeps(name: string, seen = new Set<string>()): Set<string> {
  for (const d of Object.keys(all.get(name)?.dependencies ?? {}))
    if (d.startsWith("@drift/") && !seen.has(d)) {
      seen.add(d);
      runtimeDeps(d, seen);
    }
  return seen;
}

describe("package boundaries (#336)", () => {
  it("finds the workspace manifests", () => {
    for (const n of ["@drift/sodex", "@drift/sodex-reconcile", "@drift/db", "@drift/signer"])
      expect(all.has(n), n).toBe(true);
  });

  it("@drift/sodex depends on neither @drift/db nor @drift/sodex-reconcile, directly or through another package", () => {
    const deps = runtimeDeps("@drift/sodex");
    expect(deps.has("@drift/db")).toBe(false);
    expect(deps.has("@drift/sodex-reconcile")).toBe(false);
    expect(Object.keys(all.get("@drift/sodex")?.dependencies ?? {})).not.toContain("drizzle-orm");
  });

  it("@drift/db does not depend on @drift/sodex or viem", () => {
    const db = all.get("@drift/db");
    expect(runtimeDeps("@drift/db").has("@drift/sodex")).toBe(false);
    expect(Object.keys(db?.dependencies ?? {})).not.toContain("viem");
  });

  it.each(["@drift/signer", "@drift/engine", "@drift/marketdata"])(
    "%s never pulls in @drift/sodex-reconcile",
    (app) => {
      expect(runtimeDeps(app).has("@drift/sodex-reconcile")).toBe(false);
    },
  );

  it("@drift/signer does not get @drift/db (not directly, not through @drift/sodex)", () => {
    expect(runtimeDeps("@drift/signer").has("@drift/db")).toBe(false);
  });

  it("no dependency cycle between workspace packages", () => {
    const cycles: string[] = [];
    const walk = (n: string, path: string[]) => {
      if (path.includes(n)) {
        cycles.push([...path, n].join(" → "));
        return;
      }
      for (const d of Object.keys(all.get(n)?.dependencies ?? {}))
        if (d.startsWith("@drift/")) walk(d, [...path, n]);
    };
    for (const n of all.keys()) walk(n, []);
    expect(cycles).toEqual([]);
  });
});
