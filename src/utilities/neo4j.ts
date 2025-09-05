import neo4j, { Driver } from 'neo4j-driver';
import type { NodeState, Interaction } from './types.js';
import { extractRefIdFromSnapshot } from './text.js';

export async function createDriver(uri: string, user: string, password: string): Promise<Driver> {
  return neo4j.driver(uri, neo4j.auth.basic(user, password), { disableLosslessIntegers: true });
}

export async function closeDriver(driver: Driver | null | undefined): Promise<void> {
  if (!driver) return;
  await driver.close();
}

export async function initDatabase(driver: Driver): Promise<void> {
  const session = driver.session();
  try {
    try {
      await session.run('DROP CONSTRAINT node_state_hash IF EXISTS');
      await session.run('DROP CONSTRAINT node_url IF EXISTS');
    } catch {
      // ignore
    }
    await session.run('MATCH (n) DETACH DELETE n');
    await session.run('CREATE CONSTRAINT node_state_hash IF NOT EXISTS FOR (n:Page) REQUIRE n.snapshot_hash IS UNIQUE');
    await session.run('CREATE INDEX node_site_url IF NOT EXISTS FOR (n:Page) ON (n.site, n.url)');
  } finally {
    await session.close();
  }
}

export async function findPageIdBySnapshotHash(hash: string): Promise<number | null> {
  try {
    const uri = process.env.AGENT_NEO4J_URI;
    const user = process.env.AGENT_NEO4J_USER;
    const password = process.env.AGENT_NEO4J_PASSWORD;
    if (!uri || !user || !password) return null;

    const driver = await createDriver(uri, user, password);
    const session = driver.session();
    try {
      const res = await session.run(
        'MATCH (n:Page { snapshot_hash: $hash }) RETURN id(n) AS id LIMIT 1',
        { hash }
      );
      const rec = res.records?.[0];
      if (!rec) return null;
      const idVal = rec.get('id');
      return typeof idVal === 'number' ? idVal : (Number(idVal) || null);
    } finally {
      await session.close();
      await driver.close();
    }
  } catch {
    return null;
  }
}

export async function findPageIdByHashOrUrl(hash: string, url?: string): Promise<number | null> {
  const byHash = await findPageIdBySnapshotHash(hash);
  if (byHash !== null) return byHash;
  if (!url) return null;
  try {
    const uri = process.env.AGENT_NEO4J_URI;
    const user = process.env.AGENT_NEO4J_USER;
    const password = process.env.AGENT_NEO4J_PASSWORD;
    if (!uri || !user || !password) return null;

    const driver = await createDriver(uri, user, password);
    const session = driver.session();
    try {
      const res = await session.run(
        'MATCH (n:Page { url: $url }) RETURN id(n) AS id ORDER BY n.timestamp DESC LIMIT 1',
        { url }
      );
      const rec = res.records?.[0];
      if (!rec) return null;
      const idVal = rec.get('id');
      return typeof idVal === 'number' ? idVal : (Number(idVal) || null);
    } finally {
      await session.close();
      await driver.close();
    }
  } catch {
    return null;
  }
}

export async function saveNode(driver: Driver, node: NodeState): Promise<void> {
  const session = driver.session();
  try {
    await session.run(
      `MERGE (n:Page {snapshot_hash: $snapshot_hash})
       SET n.site = $site,
           n.url = $url,
           n.snapshot_for_ai = $snapshot_for_ai,
           n.snapshot_in_md = $snapshot_in_md,
           n.timestamp = $timestamp,
           n.depth = $depth`,
      {
        snapshot_hash: node.snapshotHash,
        site: node.site,
        url: node.url,
        snapshot_for_ai: node.snapshotForAI,
        snapshot_in_md: node.snapshotInMd,
        timestamp: node.timestamp,
        depth: node.depth,
      },
    );
  } finally {
    await session.close();
  }
}

export async function labelLoginPage(driver: Driver, node: Pick<NodeState, 'snapshotHash'>): Promise<void> {
  const session = driver.session();
  try {
    await session.run(
      `MATCH (n:Page {snapshot_hash: $snapshot_hash})
       SET n:LoginPage`,
      { snapshot_hash: node.snapshotHash },
    );
  } finally {
    await session.close();
  }
}

export async function createRelation(
  driver: Driver,
  fromNode: NodeState,
  toNode: NodeState,
  interaction: Pick<Interaction, 'actionType' | 'ref' | 'refId' | 'href' | 'role' | 'name'>
): Promise<void> {
  const actionType = interaction.actionType ?? 'click';
  const ref = interaction.ref ?? interaction.refId ?? extractRefIdFromSnapshot(fromNode.snapshotForAI) ?? '';
  const href = interaction.href ?? '';
  const role = interaction.role ?? '';
  const name = interaction.name ?? '';

  if (fromNode.snapshotHash === toNode.snapshotHash) {
    // avoid self-loop by identical snapshot; nothing to create
    return;
  }

  const session = driver.session();
  try {
    if (actionType === 'navigate') {
      // to ノードに既に NAVIGATE_TO が存在すれば新規作成しない（to 単位で高々1本）
      const existsToRes = await session.run(
        `MATCH ()-[r:NAVIGATE_TO]->(b:Page {snapshot_hash: $to_hash})
         RETURN count(r) AS cnt`,
        { to_hash: toNode.snapshotHash },
      );
      const cntTo = (existsToRes.records?.[0]?.get?.('cnt')) ?? 0;
      if (Number(cntTo) > 0) {
        return;
      }
      await session.run(
        `MATCH (a:Page {snapshot_hash: $from_hash})
         MATCH (b:Page {snapshot_hash: $to_hash})
         MERGE (a)-[r:NAVIGATE_TO]->(b)
         SET r.action_type = $action_type,
             r.url = $url`,
        {
          from_hash: fromNode.snapshotHash,
          to_hash: toNode.snapshotHash,
          action_type: 'navigate_to',
          url: href,
        },
      );
    } else {
      // to ノードに既に CLICK_TO が存在すれば新規作成しない（to 単位で高々1本）
      const existsToRes = await session.run(
        `MATCH ()-[r:CLICK_TO]->(b:Page {snapshot_hash: $to_hash})
         RETURN count(r) AS cnt`,
        { to_hash: toNode.snapshotHash },
      );
      const cntTo = (existsToRes.records?.[0]?.get?.('cnt')) ?? 0;
      if (Number(cntTo) > 0) {
        return;
      }
      await session.run(
        `MATCH (a:Page {snapshot_hash: $from_hash})
         MATCH (b:Page {snapshot_hash: $to_hash})
         MERGE (a)-[r:CLICK_TO]->(b)
         SET r.action_type = $action_type,
             r.ref = $ref,
             r.href = $href,
             r.role = $role,
             r.name = $name`,
        {
          from_hash: fromNode.snapshotHash,
          to_hash: toNode.snapshotHash,
          action_type: actionType,
          ref,
          href,
          role,
          name,
        },
      );
    }
  } finally {
    await session.close();
  }
}


