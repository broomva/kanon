// Wire types — mirror the JSON the rendezvous server returns (packages/store
// record shapes + service responses). The UI never touches the git log; it
// only reads these projections and posts domain writes back through the proxy.

export interface BaseRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  deleted: boolean;
  data: Record<string, unknown>;
}

export interface TeamRecord extends BaseRecord {
  key: string | null;
  name: string | null;
}

export interface StateRecord extends BaseRecord {
  teamId: string | null;
  name: string | null;
  stateType: string | null;
  color: string | null;
  position: number | null;
}

export interface ProjectRecord extends BaseRecord {
  name: string | null;
  description: string | null;
  state: string | null;
  leadId: string | null;
  targetDate: string | null;
}

export interface LabelRecord extends BaseRecord {
  teamId: string | null;
  name: string | null;
  color: string | null;
}

export interface ActorRecord extends BaseRecord {
  name: string | null;
  displayName: string | null;
  email: string | null;
  actorType: string | null;
}

export interface MilestoneRecord extends BaseRecord {
  projectId: string | null;
  name: string | null;
  targetDate: string | null;
}

export interface IssueRecord extends BaseRecord {
  teamId: string | null;
  number: number | null;
  identifier: string | null;
  title: string | null;
  description: string | null;
  stateId: string | null;
  priority: number | null;
  estimate: number | null;
  assigneeId: string | null;
  delegateId: string | null;
  parentId: string | null;
  projectId: string | null;
  milestoneId: string | null;
  labelIds: string[];
}

export interface CommentRecord extends BaseRecord {
  issueId: string | null;
  body: string | null;
  actorId: string | null;
  parentId: string | null;
}

export interface RelationRecord extends BaseRecord {
  relType: string | null;
  issueId: string | null;
  relatedIssueId: string | null;
}

export interface RelationView extends RelationRecord {
  issueIdentifier: string | null;
  relatedIssueIdentifier: string | null;
}

export interface AgentSessionRecord extends BaseRecord {
  issueId: string | null;
  actorId: string | null;
  state: string | null;
}

export interface AgentActivityRecord extends BaseRecord {
  sessionId: string | null;
  type: string | null;
  body: string | null;
}

// -- service responses --------------------------------------------------------

export interface Catalog {
  workspace: string;
  teams: TeamRecord[];
  states: StateRecord[];
  projects: ProjectRecord[];
  labels: LabelRecord[];
  actors: ActorRecord[];
  milestones: MilestoneRecord[];
}

export interface IssueDetail {
  issue: IssueRecord;
  state: StateRecord | null;
  comments: CommentRecord[];
  relations: RelationView[];
}

export interface AgentSessionDetail {
  session: AgentSessionRecord;
  issue: IssueRecord | null;
  activities: AgentActivityRecord[];
}

// The event shape the SSE stream carries. The UI only needs the routing fields
// (model / modelId / op) to decide what projection to invalidate.
export interface KanonEvent {
  id: string;
  workspace?: string;
  model?: string;
  modelId?: string;
  op?: string;
  actor?: { type?: string; id?: string; sessionId?: string; surface?: string };
  data?: Record<string, unknown>;
}
