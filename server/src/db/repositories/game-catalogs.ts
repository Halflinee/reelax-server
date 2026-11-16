import { BaseRepo, now } from "./base.ts";

export type GameCatalogRow = { base_url: string; content_json: string; updated_at: number };

/** 按游戏服务器保存公开地图和鱼种定义，不存账号、库存、凭证等个人数据。 */
export class GameCatalogsRepo extends BaseRepo {
  find(baseUrl: string): GameCatalogRow | null {
    return this.db.get<GameCatalogRow>("SELECT * FROM game_catalogs WHERE base_url=?", baseUrl) ?? null;
  }
  save(baseUrl: string, contentJson: string): void {
    this.db.run(`INSERT INTO game_catalogs(base_url,content_json,updated_at) VALUES(?,?,?)
      ON CONFLICT(base_url) DO UPDATE SET content_json=excluded.content_json,updated_at=excluded.updated_at`, baseUrl, contentJson, now());
  }
}
