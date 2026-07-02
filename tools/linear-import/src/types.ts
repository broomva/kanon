/**
 * LinearExport — the plain-JSON snapshot of a Linear workspace that the
 * importer consumes. Produced either by `fetch.ts` (live, via @linear/sdk)
 * or loaded from a fixture file; the transform is pure over this shape so
 * a live pull captured once with --save-export can be re-run offline.
 *
 * All `*LinearId` fields are Linear's own UUIDs. Kanon never uses them as
 * keys — the transform maps every linearId to a ULID modelId and stores the
 * linearId inside event data so re-runs stay idempotent.
 */

export interface LinearStateExport {
  linearId: string;
  name: string;
  type: string;
  color: string;
  position: number;
}

export interface LinearTeamExport {
  linearId: string;
  key: string;
  name: string;
  states: LinearStateExport[];
}

export interface LinearLabelExport {
  linearId: string;
  name: string;
  color?: string;
  teamLinearId?: string;
}

export interface LinearUserExport {
  linearId: string;
  name: string;
  displayName: string;
  email: string;
  isAgent?: boolean;
}

export interface LinearProjectExport {
  linearId: string;
  name: string;
  description?: string;
  state?: string;
  leadLinearId?: string;
  targetDate?: string;
  teamLinearIds: string[];
}

export interface LinearMilestoneExport {
  linearId: string;
  projectLinearId: string;
  name: string;
  targetDate?: string;
}

export interface LinearInitiativeExport {
  linearId: string;
  name: string;
  description?: string;
  targetDate?: string;
}

export interface LinearRelationExport {
  /** Linear relation type: blocks, duplicate, related, similar. */
  type: string;
  relatedIssueLinearId: string;
}

export interface LinearIssueExport {
  linearId: string;
  teamLinearId: string;
  number: number;
  /** Human display identifier, e.g. BRO-1234 — preserved as display data. */
  identifier: string;
  title: string;
  description?: string;
  priority?: number;
  estimate?: number;
  stateLinearId?: string;
  assigneeLinearId?: string;
  parentLinearId?: string;
  projectLinearId?: string;
  milestoneLinearId?: string;
  labelLinearIds: string[];
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  relations: LinearRelationExport[];
}

export interface LinearCommentExport {
  linearId: string;
  issueLinearId: string;
  body: string;
  userLinearId?: string;
  /** Set for replies: the parent comment's linearId. */
  parentLinearId?: string;
  createdAt: string;
}

export interface LinearExport {
  /** Workspace slug the emitted events will carry. */
  workspace: string;
  teams: LinearTeamExport[];
  labels: LinearLabelExport[];
  users: LinearUserExport[];
  projects: LinearProjectExport[];
  milestones: LinearMilestoneExport[];
  initiatives: LinearInitiativeExport[];
  issues: LinearIssueExport[];
  comments: LinearCommentExport[];
}
