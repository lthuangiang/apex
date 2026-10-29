import { analysisViewSchema, latestImportSchema, meSchema } from "@drift/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { signIn, startTestEnv, TestClient, type TestEnv } from "./helpers";

let env: TestEnv;
beforeAll(async () => {
  env = await startTestEnv();
});
afterAll(async () => {
  await env.close();
});

describe("imports and analysis", () => {
  it("queues an import with an outbox message in the same transaction", async () => {
    const client = new TestClient(env.app);
    const me = meSchema.parse((await signIn(env, client, "import@example.com")).json());
    expect((await client.request("POST", "/api/v1/imports")).statusCode).toBe(404);

    await env.pool.query(
      "insert into sodex_accounts (id, user_id, address, sodex_account_id, network, status) values (gen_random_uuid(), $1, $2, 991, 'mainnet', 'connected')",
      [me.id, "0x4E1e4796c10C637EDAB56461450BD8D02EFb29Db"],
    );
    const res = await client.request("POST", "/api/v1/imports");
    expect(res.statusCode).toBe(202);
    const created = latestImportSchema.parse(res.json()).import;
    expect(created?.status).toBe("queued");
    const { rows } = await env.pool.query<{ payload: { importId: string } }>(
      "select payload from outbox where topic = 'jobs.import'",
    );
    expect(rows.map((r) => r.payload.importId)).toContain(created?.id);

    const latest = latestImportSchema.parse(
      (await client.request("GET", "/api/v1/imports/latest")).json(),
    );
    expect(latest.import?.id).toBe(created?.id);
    const analysis = analysisViewSchema.parse(
      (await client.request("GET", "/api/v1/analysis/latest")).json(),
    );
    expect(analysis.analysis).toBeNull();
  });
});
