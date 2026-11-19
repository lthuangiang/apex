import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDb, MIGRATIONS_FOLDER } from "@drift/db";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { POSTGRES_IMAGE } from "./helpers";

// #348: migration thêm `signal_classification_labels.source`. Nhãn có trước migration không chứng minh được là được
// chọn ngẫu nhiên, nên đều thành `trace` (không tính cổng precision). Chạy migration tới ngay trước nó, chèn nhãn cũ, rồi
// chạy hết.

let container: StartedPostgreSqlContainer;
let dir: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  dir = mkdtempSync(join(tmpdir(), "mig-label-source-"));
}, 120_000);

afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  await container.stop();
});

describe("migration sr_label_source on existing labels", () => {
  it("existing labels become trace; source only accepts random / trace; a new row defaults to trace", async () => {
    cpSync(MIGRATIONS_FOLDER, dir, { recursive: true });
    const journalPath = join(dir, "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { tag: string }[] };
    const tag = journal.entries.find((e) => e.tag.endsWith("_sr_label_source"))?.tag;
    expect(tag).toBeDefined();
    const cut = tag ?? "";
    // Bỏ migration này VÀ mọi migration sau nó (migrator chỉ chạy migration mới hơn migration cuối đã chạy).
    const later = journal.entries.filter((e) => e.tag >= cut);
    journal.entries = journal.entries.filter((e) => e.tag < cut);
    writeFileSync(journalPath, JSON.stringify(journal));
    for (const e of later) rmSync(join(dir, `${e.tag}.sql`));

    const p = createDb(container.getConnectionUri());
    try {
      await migrate(p.db, { migrationsFolder: dir });
      await p.pool.query(`
        insert into users (id, email) values ('00000000-0000-7000-8000-0000000000a1', 'mig-label@drift.test');
        insert into signal_classification_labels (id, article_id, classifier_version, labeled_by, verdict, reason) values
          ('00000000-0000-7000-8000-0000000000b1', 'a-1', 'news-classifier-v2', '00000000-0000-7000-8000-0000000000a1', 'right', null),
          ('00000000-0000-7000-8000-0000000000b2', 'a-2', 'news-classifier-v2', '00000000-0000-7000-8000-0000000000a1', 'wrong', 'other');
      `);
      await migrate(p.db, { migrationsFolder: MIGRATIONS_FOLDER });

      const rows = await p.pool.query<{ article_id: string; source: string }>(
        "select article_id, source from signal_classification_labels order by article_id",
      );
      expect(rows.rows).toEqual([
        { article_id: "a-1", source: "trace" },
        { article_id: "a-2", source: "trace" },
      ]);
      await expect(
        p.pool.query(
          `insert into signal_classification_labels (id, article_id, classifier_version, labeled_by, verdict, source)
           values (gen_random_uuid(), 'a-3', 'news-classifier-v2', '00000000-0000-7000-8000-0000000000a1', 'right', 'served')`,
        ),
      ).rejects.toThrow(/signal_classification_labels_source_ck/);
      await p.pool.query(
        `insert into signal_classification_labels (id, article_id, classifier_version, labeled_by, verdict)
         values (gen_random_uuid(), 'a-4', 'news-classifier-v2', '00000000-0000-7000-8000-0000000000a1', 'right')`,
      );
      const a4 = await p.pool.query<{ source: string }>(
        "select source from signal_classification_labels where article_id = 'a-4'",
      );
      expect(a4.rows[0]?.source).toBe("trace");
      // Bảng token có, rỗng.
      const tokens = await p.pool.query<{ n: number }>(
        "select count(*)::int as n from signal_label_tokens",
      );
      expect(tokens.rows[0]?.n).toBe(0);
    } finally {
      await p.pool.end();
    }
  });
});
