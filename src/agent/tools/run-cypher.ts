import type { Driver } from 'neo4j-driver';
import { createDriver, closeDriver } from '../neo4j.js';
import { attachTodos } from './util.js';

export async function runCypher(query: string): Promise<string> {
  try {
    const uri = process.env.AGENT_NEO4J_URI;
    const user = process.env.AGENT_NEO4J_USER;
    const password = process.env.AGENT_NEO4J_PASSWORD;
    if (!uri || !user || !password) {
      const payload = await attachTodos({ ok: false, error: 'エラー: Neo4j接続情報(AGENT_NEO4J_URI/AGENT_NEO4J_USER/AGENT_NEO4J_PASSWORD)が未設定です' });
      return JSON.stringify(payload);
    }

    let driver: Driver | null = null;
    driver = await createDriver(uri, user, password);
    const session = driver.session();
    try {
      const res = await session.run(query);
      const records = res.records.map((r) => r.toObject());
      if (!records.length) {
        const payload = await attachTodos({ ok: true, result: '結果: データが見つかりませんでした' });
        return JSON.stringify(payload);
      }
      const lines: string[] = [];
      records.slice(0, 20).forEach((rec, i) => lines.push(`レコード ${i + 1}: ${JSON.stringify(rec)}`));
      if (records.length > 20) lines.push(`\n... 他 ${records.length - 20} 件のレコードがあります`);
      const payload = await attachTodos({ ok: true, result: lines.join('\n') });
      return JSON.stringify(payload);
    } finally {
      await session.close();
      await closeDriver(driver);
    }
  } catch (e: any) {
    const payload = await attachTodos({ ok: false, error: `エラー: ${String(e?.message ?? e)}` });
    return JSON.stringify(payload);
  }
}


// 旧 searchByKeywords は keyword_search に置き換え済み