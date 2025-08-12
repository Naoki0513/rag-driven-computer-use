export interface NodeState {
  site: string;
  route: string;
  snapshotForAI: string;
  snapshotHash: string;
  timestamp: string;
}

export type ActionType = 'click' | 'input' | 'select' | 'navigate' | 'submit';

export interface Interaction {
  actionType: ActionType;
  role?: string | null;
  name?: string | null;
  ref?: string | null;
  href?: string | null;
  refId?: string | null;
}

export interface QueueItem {
  node: NodeState;
  depth: number;
}


