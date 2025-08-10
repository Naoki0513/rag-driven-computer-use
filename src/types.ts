export interface NodeState {
  // Stored in Neo4j node properties as: url, snapshot_for_ai, timestamp
  url: string;
  snapshotForAI: string; // textual snapshot (may include [ref=...])
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

