export interface NodeState {
  // Stored in Neo4j node properties as: snapshot_hash (unique), snapshot_for_ai, site, route, timestamp
  site: string; // origin (e.g., http://example.com:3000)
  route: string; // path + sorted querystring without hash (e.g., /foo/bar?b=1&a=2)
  snapshotForAI: string; // textual snapshot (may include [ref=...])
  snapshotHash: string; // sha256 hash of snapshotForAI used as unique identity of the state
  timestamp: string; // ISO string
}

export type ActionType = 'click' | 'input' | 'select' | 'navigate' | 'submit';

export interface Interaction {
  actionType: ActionType;
  role?: string | null;
  name?: string | null;
  // Primary key to operate elements. Prefer this over any selector.
  ref?: string | null;
  // Optional href if provided by snapshotForAI for link-like elements
  href?: string | null;
  // Backward compatibility: some paths may still set refId
  refId?: string | null;
}

export interface QueueItem {
  node: NodeState;
  depth: number;
}

