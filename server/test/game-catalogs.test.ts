import { mkdtempSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/client.ts";
import { createRepos } from "../src/db/repositories/index.ts";

describe("固定资料本地存储", () => {
  it("关闭并重新打开磁盘数据库后仍能读取，按游戏服务器分别保存", () => {
    const directory = mkdtempSync(join(tmpdir(), "reelax-catalog-test-"));
    const filename = join(directory, "catalog.sqlite");
    let db = openDb(filename);
    let backup: string | null = null;
    try {
      backup = db.migrate().backup;
      const repos = createRepos(db);
      repos.gameCatalogs.save("https://game-a.example", '{"fish":[{"id":"a"}],"biomes":[]}');
      repos.gameCatalogs.save("https://game-b.example", '{"fish":[{"id":"b"}],"biomes":[]}');
      db.close();
      db = openDb(filename);
      expect(db.migrate().applied).toEqual([]);
      const reopened = createRepos(db);
      expect(reopened.gameCatalogs.find("https://game-a.example")?.content_json).toContain('"a"');
      expect(reopened.gameCatalogs.find("https://game-b.example")?.content_json).toContain('"b"');
      expect(reopened.gameCatalogs.find("https://missing.example")).toBeNull();
    } finally {
      db.close();
      // 只清理本测试刚创建的几个具体文件，不递归删除目录。
      for (const suffix of ["", "-wal", "-shm"]) rmSync(filename + suffix, { force: true });
      if (backup) rmSync(backup, { force: true });
      rmdirSync(directory);
    }
  });
});
