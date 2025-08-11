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
    await session.run('CREATE INDEX node_site_route IF NOT EXISTS FOR (n:Page) ON (n.site, n.route)');
  } finally {
    await session.close();
  }
}

export async function saveNode(driver: Driver, node: NodeState): Promise<void> {
  const session = driver.session();
  try {
    await session.run(
      `MERGE (n:Page {site: $site, route: $route})
       SET n.snapshot_for_ai = $snapshot_for_ai,
           n.timestamp = $timestamp`,
      {
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

  const session = driver.session();
  try {
    await session.run(
      `MATCH (a:Page {site: $from_site, route: $from_route})
       MATCH (b:Page {site: $to_site, route: $to_route})
       MERGE (a)-[r:${relType}]->(b)
       SET r.action_type = $action_type,
           r.ref = $ref,
           r.href = $href,
           r.role = $role,
           r.name = $name`,
      {
        from_site: fromNode.site,
        from_route: fromNode.route,
        to_site: toNode.site,
        to_route: toNode.route,
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

