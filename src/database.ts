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
    await session.run('CREATE CONSTRAINT node_state_hash IF NOT EXISTS FOR (n:Page) REQUIRE n.snapshot_hash IS UNIQUE');
    await session.run('CREATE INDEX node_site_route IF NOT EXISTS FOR (n:Page) ON (n.site, n.route)');
  } finally {
    await session.close();
  }
}

export async function saveNode(driver: Driver, node: NodeState): Promise<void> {
  const session = driver.session();
  try {
    await session.run(
      `MERGE (n:Page {snapshot_hash: $snapshot_hash})
       SET n.site = $site,
           n.route = $route,
           n.snapshot_for_ai = $snapshot_for_ai,
           n.timestamp = $timestamp`,
      {
        snapshot_hash: node.snapshotHash,
        site: node.site,
        route: node.route,
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
  interaction: Pick<Interaction, 'actionType' | 'ref' | 'refId' | 'href' | 'role' | 'name'>
): Promise<void> {
  const relType = 'CLICK_TO';
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
    await session.run(
      `MATCH (a:Page {snapshot_hash: $from_hash})
       MATCH (b:Page {snapshot_hash: $to_hash})
       MERGE (a)-[r:${relType}]->(b)
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
  } finally {
    await session.close();
  }
}

