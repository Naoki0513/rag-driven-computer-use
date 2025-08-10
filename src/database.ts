import neo4j, { Driver } from 'neo4j-driver';
import type { NodeState, Interaction } from './types.js';
import { extractRefIdFromSnapshot } from './utils.js';

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
    await session.run('CREATE INDEX node_url IF NOT EXISTS FOR (n:Page) ON (n.url)');
  } finally {
    await session.close();
  }
}

export async function saveNode(driver: Driver, node: NodeState): Promise<void> {
  const session = driver.session();
  try {
    await session.run(
      `MERGE (n:Page {url: $url})
       SET n.snapshot_for_ai = $snapshot_for_ai,
           n.timestamp = $timestamp`,
      {
        url: node.url,
        snapshot_for_ai: node.snapshotForAI,
        timestamp: node.timestamp,
      },
    );
  } finally {
    await session.close();
  }
}

export async function createRelation(
  driver: Driver,
  fromNode: NodeState,
  toNode: NodeState,
  interaction: Pick<Interaction, 'actionType' | 'refId'>
): Promise<void> {
  const relType = 'CLICK_TO';
  const actionType = interaction.actionType ?? 'click';
  const refId = interaction.refId ?? extractRefIdFromSnapshot(fromNode.snapshotForAI) ?? null;

  const session = driver.session();
  try {
    await session.run(
      `MATCH (a:Page {url: $from_url})
       MATCH (b:Page {url: $to_url})
       MERGE (a)-[r:${relType}]->(b)
       SET r.action_type = $action_type,
           r.ref_id = $ref_id`,
      {
        from_url: fromNode.url,
        to_url: toNode.url,
        action_type: actionType,
        ref_id: refId,
      },
    );
  } finally {
    await session.close();
  }
}

