import type { Driver } from 'neo4j-driver';
import { createDriver, closeDriver } from '../../utilities/neo4j.js';

export async function runCypher(query: string): Promise<string> {
  const uri = process.env.AGENT_NEO4J_URI;
  const user = process.env.AGENT_NEO4J_USER;
  const password = process.env.AGENT_NEO4J_PASSWORD;
  if (!uri || !user || !password) return 'エラー: Neo4j接続情報(AGENT_NEO4J_URI/AGENT_NEO4J_USER/AGENT_NEO4J_PASSWORD)が未設定です';

  let driver: Driver | null = null;
  driver = await createDriver(uri, user, password);
  const session = driver.session();
  try {
    const res = await session.run(query);
    const records = res.records.map((r) => r.toObject());
    if (!records.length) return '結果: データが見つかりませんでした';
    const lines: string[] = [];
    records.slice(0, 20).forEach((rec, i) => lines.push(`レコード ${i + 1}: ${JSON.stringify(rec)}`));
    if (records.length > 20) lines.push(`\n... 他 ${records.length - 20} 件のレコードがあります`);
    return lines.join('\n');
  } finally {
    await session.close();
    await closeDriver(driver);
  }
}




