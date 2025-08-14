import type { Driver } from 'neo4j-driver';
import { createDriver, closeDriver } from '../utilities/neo4j.js';

async function queryAll<T = any>(driver: Driver, cypher: string): Promise<T[]> {
  const session = driver.session();
  try {
    const res = await session.run(cypher);
    return res.records.map((r) => r.toObject() as T);
  } finally {
    await session.close();
  }
}

export async function getDatabaseSchemaString(): Promise<string> {
  const uri = process.env.NEO4J_URI;
  const user = process.env.NEO4J_USER;
  const password = process.env.NEO4J_PASSWORD;
  if (!uri || !user || !password) {
    return 'スキーマ取得エラー: NEO4J_URI/NEO4J_USER/NEO4J_PASSWORD が未設定です';
  }
  let driver: Driver | null = null;
  try {
    driver = await createDriver(uri, user, password);

    const labels = await queryAll<{ label: string }>(driver, 'CALL db.labels() YIELD label RETURN label');
    const labelList = labels.map((x) => x.label);

    const rels = await queryAll<{ relationshipType: string }>(
      driver,
      'CALL db.relationshipTypes() YIELD relationshipType RETURN relationshipType',
    );
    const relList = rels.map((x) => x.relationshipType);

    const nodeProps: Record<string, string[]> = {};
    for (const label of labelList) {
      const props = await queryAll<{ key: string }>(
        driver,
        `MATCH (n:${label}) UNWIND keys(n) AS key RETURN DISTINCT key`,
      );
      nodeProps[label] = props.map((p) => p.key);
    }

    const relProps: Record<string, string[]> = {};
    for (const r of relList) {
      const props = await queryAll<{ key: string }>(
        driver,
        `MATCH ()-[x:${r}]->() UNWIND keys(x) AS key RETURN DISTINCT key`,
      );
      relProps[r] = props.map((p) => p.key);
    }

    const nodeCounts: string[] = [];
    for (const label of labelList) {
      const res = await queryAll<{ count: number }>(driver, `MATCH (n:${label}) RETURN count(n) as count`);
      if (res[0]) nodeCounts.push(`  - ${label}: ${res[0].count}ノード (プロパティ: ${(nodeProps[label] ?? []).join(', ')})`);
    }

    const relCounts: string[] = [];
    for (const r of relList) {
      const res = await queryAll<{ count: number }>(driver, `MATCH ()-[x:${r}]->() RETURN count(x) as count`);
      if (res[0]) relCounts.push(`  - ${r}: ${res[0].count}件 (プロパティ: ${(relProps[r] ?? []).join(', ')})`);
    }

    const info = `
データベーススキーマ情報:
- ノードラベル: ${labelList.length ? labelList.join(', ') : 'なし'}
${nodeCounts.join('\n')}

- リレーションシップタイプ: ${relList.length ? relList.join(', ') : 'なし'}
${relCounts.join('\n')}
 
 - エントリページ(depth=1)概要:
 ${await (async () => {
   try {
     const depth1Counts = await queryAll<{ site: string; pages: number }>(
       driver!,
       'MATCH (p:Page { depth: 1 }) RETURN p.site AS site, count(p) AS pages ORDER BY pages DESC LIMIT 20'
     );
     const siteLines = depth1Counts.map((r) => `  - ${r.site}: depth=1 ページ数 ${r.pages}`);
 
     const relFromDepth1 = await queryAll<{ rel: string; c: number }>(
       driver!,
       'MATCH (:Page { depth: 1 })-[r]->() RETURN type(r) AS rel, count(r) AS c ORDER BY c DESC LIMIT 10'
     );
     const relLines = relFromDepth1.map((r) => `  - ${r.rel}: ${r.c} 件（depth=1 からの遷移）`);
 
     const targetDepthDist = await queryAll<{ depth: number; c: number }>(
       driver!,
       'MATCH (:Page { depth: 1 })-[r]->(t:Page) RETURN t.depth AS depth, count(r) AS c ORDER BY c DESC'
     );
     const depthLines = targetDepthDist.map((r) => `  - t.depth=${r.depth}: ${r.c} 件`);
 
     return [
       siteLines.length ? siteLines.join('\n') : '  - 該当なし',
       '\n  リレーション（depth=1 起点）:\n' + (relLines.length ? relLines.join('\n') : '    - 該当なし'),
       '\n  遷移先の深さ分布:\n' + (depthLines.length ? depthLines.join('\n') : '    - 該当なし'),
     ].join('\n');
   } catch (e) {
     return `  - 取得失敗: ${String((e as any)?.message ?? e)}`;
   }
 })()}
`;
    return info;
  } catch (e: any) {
    return `スキーマ取得エラー: ${String(e?.message ?? e)}`;
  } finally {
    await closeDriver(driver);
  }
}


