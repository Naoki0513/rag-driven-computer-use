export interface NodeState {
  // Stored in Neo4j node properties as: url, snapshot_for_ai, timestamp
  url: string;
  snapshotForAI: string; // textual snapshot (may include [ref=...])
  timestamp: string; // ISO string
}

export type ActionType = 'click' | 'input' | 'select' | 'navigate' | 'submit';

export interface Interaction {
  selector: string | null;
  text: string;
  actionType: ActionType;
  href?: string | null;
  role?: string | null;
  name?: string | null;
  inputValue?: string | null;
  selectedValue?: string | null;
  formId?: string | null;
  // Extracted from snapshot_for_ai if available
  refId?: string | null;
}

export interface QueueItem {
  node: NodeState;
  depth: number;
}

