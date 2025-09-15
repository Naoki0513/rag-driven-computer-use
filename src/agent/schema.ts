import type { Driver } from 'neo4j-driver';
import { createDriver, closeDriver } from './neo4j.js';

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
  const uri = process.env.AGENT_NEO4J_URI;
  const user = process.env.AGENT_NEO4J_USER;
  const password = process.env.AGENT_NEO4J_PASSWORD;
  if (!uri || !user || !password) {
    return 'スキーマ取得エラー: AGENT_NEO4J_URI/AGENT_NEO4J_USER/AGENT_NEO4J_PASSWORD が未設定です';
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
      nodeProps[label] = props.map((p) => p.key).sort();
    }

    const relProps: Record<string, string[]> = {};
    for (const r of relList) {
      const props = await queryAll<{ key: string }>(
        driver,
        `MATCH ()-[x:${r}]->() UNWIND keys(x) AS key RETURN DISTINCT key`,
      );
      relProps[r] = props.map((p) => p.key).sort();
    }

    // 件数情報
    const nodeCounts: string[] = [];
    for (const label of labelList) {
      const res = await queryAll<{ count: number }>(driver, `MATCH (n:${label}) RETURN count(n) as count`);
      const props = nodeProps[label] ?? [];
      if (res[0]) nodeCounts.push(`  - ${label}: ${res[0].count}ノード (プロパティ: ${props.length ? props.join(', ') : 'なし'})`);
    }

    const relCounts: string[] = [];
    for (const r of relList) {
      const res = await queryAll<{ count: number }>(driver, `MATCH ()-[x:${r}]->() RETURN count(x) as count`);
      const props = relProps[r] ?? [];
      if (res[0]) relCounts.push(`  - ${r}: ${res[0].count}件 (プロパティ: ${props.length ? props.join(', ') : 'なし'})`);
    }

    // ラベル毎/リレーション毎のキー一覧（網羅）
    const labelsSection = labelList.length
      ? labelList.map((l) => {
          const props = nodeProps[l] ?? [];
          const list = props.length ? props : ['なし'];
          return `  - ${l}: ${list.join(', ')}`;
        }).join('\n')
      : '  - なし';

    const relsSection = relList.length
      ? relList.map((r) => {
          const props = relProps[r] ?? [];
          const list = props.length ? props : ['なし'];
          return `  - ${r}: ${list.join(', ')}`;
        }).join('\n')
      : '  - なし';

    const info = `
データベーススキーマ情報:

- ノードラベルとそのプロパティキー一覧:
${labelsSection}

- リレーションシップタイプとそのプロパティキー一覧:
${relsSection}

- ノードラベル概要: ${labelList.length ? labelList.join(', ') : 'なし'}
${nodeCounts.join('\n')}

- リレーションシップタイプ概要: ${relList.length ? relList.join(', ') : 'なし'}
${relCounts.join('\n')}
 
 - 参考（Page 起点のサマリ）:
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


