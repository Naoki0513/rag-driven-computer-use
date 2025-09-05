import type { Driver } from 'neo4j-driver';
import { createDriver, closeDriver } from '../../utilities/neo4j.js';

// keyword_search: 各ページをテキスト化した Markdown（snapshot_in_md）を対象に、
// 与えられたキーワード配列を AND 条件で検索し、関連しそうな Page を最大3件返す。
// 目的は「たどり着きたいページを見つけて id(p) を取得する」こと。
export async function keywordSearch(keywords: string[]): Promise<string> {
  try {
    const uri = process.env.AGENT_NEO4J_URI;
    const user = process.env.AGENT_NEO4J_USER;
    const password = process.env.AGENT_NEO4J_PASSWORD;
    if (!uri || !user || !password) return 'エラー: Neo4j接続情報(AGENT_NEO4J_URI/AGENT_NEO4J_USER/AGENT_NEO4J_PASSWORD)が未設定です';

    const list = Array.isArray(keywords) ? keywords.filter((k) => typeof k === 'string' && k.trim().length > 0) : [];
    if (!list.length) return 'エラー: keywords が空です';

    let driver: Driver | null = null;
    driver = await createDriver(uri, user, password);
    const session = driver.session();
    try {
      const cypher = `
WITH $keywords AS kws
MATCH (p:Page)
WHERE all(k IN kws WHERE toLower(p.snapshot_in_md) CONTAINS toLower(k))
RETURN id(p) AS id, p.snapshot_in_md AS snapshot_in_md, p.depth AS depth, p.url AS url
ORDER BY id ASC
LIMIT 3`;
      const res = await session.run(cypher, { keywords: list });
      const records = res.records.map((r) => r.toObject());
      if (!records.length) return '結果: 対象ページが見つかりませんでした';
      const lines: string[] = [];
      records.forEach((rec, i) => lines.push(`レコード ${i + 1}: ${JSON.stringify(rec)}`));
      return lines.join('\n');
    } finally {
      await session.close();
      await closeDriver(driver);
    }
  } catch (e: any) {
    return `エラー: ${String(e?.message ?? e)}`;
  }
}


