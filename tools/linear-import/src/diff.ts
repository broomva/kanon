/**
 * Mirror-diff core — does the Kanon shadow faithfully represent live Linear?
 *
 * Pure over normalized, linearId-keyed issue views. The fetching (live Linear
 * via @linear/sdk, Kanon via the shadow REST API) and the ref→linearId
 * cross-walk normalization live here too, but the network I/O is in
 * diff-cli.ts. This module NEVER writes to either system — it is the read-only
 * verification gate for the BRO-1651 cutover soak.
 *
 * Identity: every Kanon entity carries its Linear UUID in `data.linearId`, so
 * both sides are compared in the same linearId space (state/assignee/project/
 * parent/label references included) — no fragile name matching.
 */

import type { LinearIssueExport } from "./types";

/** An issue reduced to the fields the mirror must reproduce, in linearId space. */
export interface NormIssue {
  linearId: string;
  /** Display id (BRO-1234) — for human-readable reports only, never compared. */
  identifier: string;
  title: string;
  /** Trimmed; "" when absent. */
  description: string;
  /** 0 (None) when absent. */
  priority: number;
  stateLinearId: string;
  assigneeLinearId: string;
  projectLinearId: string;
  parentLinearId: string;
  /** Sorted + deduped linearIds. */
  labelLinearIds: string[];
  archived: boolean;
}

export interface FieldMismatch {
  field: string;
  linear: unknown;
  kanon: unknown;
  /** Soft fields (description) are reported but never break convergence. */
  soft?: boolean;
}
export interface IssueMismatch {
  linearId: string;
  identifier: string;
  fields: FieldMismatch[];
}
export interface IssueRef {
  linearId: string;
  identifier: string;
}

export interface DiffReport {
  /** Issues in Linear (source of truth). */
  linearCount: number;
  /** Kanon issues carrying a linearId (the mirror scope). */
  kanonCount: number;
  /** Kanon issues WITHOUT a linearId — created natively in Kanon, not mirrored. */
  kanonNative: number;
  /** Joined issues that are byte-identical across every compared field. */
  matched: number;
  /** Joined issues with ≥1 HARD field difference (drift — breaks convergence). */
  mismatches: IssueMismatch[];
  /** Joined issues where ONLY the description differs (soft — does not break convergence). */
  descriptionOnly: IssueRef[];
  /** In Linear, absent from the shadow — a real gap (breaks convergence). */
  onlyInLinear: IssueRef[];
  /** In the shadow, not in the current Linear pull — a Linear deletion the importer can't propagate, or (rarely) an issue absent from the pull. Soft. */
  onlyInKanon: IssueRef[];
  /** onlyInLinear.length === 0 && mismatches.length === 0. */
  converged: boolean;
}

/** Hard fields — any difference is real drift. `description` is compared but soft. */
const HARD_FIELDS: readonly (keyof NormIssue)[] = [
  "title",
  "priority",
  "stateLinearId",
  "assigneeLinearId",
  "projectLinearId",
  "parentLinearId",
  "archived",
];

function ref(issue: NormIssue): IssueRef {
  return { linearId: issue.linearId, identifier: issue.identifier };
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** All differing fields between two joined issues (hard fields first, then labels, then description). */
function compareFields(linear: NormIssue, kanon: NormIssue): FieldMismatch[] {
  const out: FieldMismatch[] = [];
  for (const field of HARD_FIELDS) {
    if (linear[field] !== kanon[field]) {
      out.push({ field, linear: linear[field], kanon: kanon[field] });
    }
  }
  if (!sameSet(linear.labelLinearIds, kanon.labelLinearIds)) {
    out.push({ field: "labels", linear: linear.labelLinearIds, kanon: kanon.labelLinearIds });
  }
  if (linear.description !== kanon.description) {
    out.push({
      field: "description",
      linear: linear.description,
      kanon: kanon.description,
      soft: true,
    });
  }
  return out;
}

/**
 * Compare the normalized Linear (truth) and Kanon (mirror) issue sets. `kanon`
 * carries only issues WITH a linearId; `kanonNative` is the count of Kanon-only
 * issues excluded from the join (reported, never a mismatch).
 */
export function diffIssues(linear: NormIssue[], kanon: NormIssue[], kanonNative = 0): DiffReport {
  const kanonById = new Map(kanon.map((issue) => [issue.linearId, issue]));
  const linearById = new Map(linear.map((issue) => [issue.linearId, issue]));

  const mismatches: IssueMismatch[] = [];
  const descriptionOnly: IssueRef[] = [];
  const onlyInLinear: IssueRef[] = [];
  const onlyInKanon: IssueRef[] = [];
  let matched = 0;

  for (const lin of linear) {
    const kan = kanonById.get(lin.linearId);
    if (kan === undefined) {
      onlyInLinear.push(ref(lin));
      continue;
    }
    const fields = compareFields(lin, kan);
    if (fields.length === 0) {
      matched++;
    } else if (fields.every((f) => f.soft === true)) {
      descriptionOnly.push(ref(lin));
    } else {
      mismatches.push({ linearId: lin.linearId, identifier: lin.identifier, fields });
    }
  }
  for (const kan of kanon) {
    if (!linearById.has(kan.linearId)) onlyInKanon.push(ref(kan));
  }

  return {
    linearCount: linear.length,
    kanonCount: kanon.length,
    kanonNative,
    matched,
    mismatches,
    descriptionOnly,
    onlyInLinear,
    onlyInKanon,
    converged: onlyInLinear.length === 0 && mismatches.length === 0,
  };
}

// ---------------------------------------------------------------------------
// Normalization (pure — the network fetch that produces the inputs is in
// diff-cli.ts). Both sides reduce to NormIssue in the shared linearId space.
// ---------------------------------------------------------------------------

export function normalizeLinearIssue(issue: LinearIssueExport): NormIssue {
  return {
    linearId: issue.linearId,
    identifier: issue.identifier,
    title: issue.title ?? "",
    description: (issue.description ?? "").trim(),
    priority: issue.priority ?? 0,
    stateLinearId: issue.stateLinearId ?? "",
    assigneeLinearId: issue.assigneeLinearId ?? "",
    projectLinearId: issue.projectLinearId ?? "",
    parentLinearId: issue.parentLinearId ?? "",
    labelLinearIds: [...new Set(issue.labelLinearIds ?? [])].sort(),
    archived: issue.archivedAt !== undefined && issue.archivedAt !== null,
  };
}

/** A Kanon entity as served by the REST API — only the fields the diff reads. */
export interface KanonEntity {
  id: string;
  data?: { linearId?: string } | null;
}
export interface KanonCatalog {
  states: KanonEntity[];
  projects: KanonEntity[];
  labels: KanonEntity[];
  actors: KanonEntity[];
}
export interface KanonIssue extends KanonEntity {
  identifier: string | null;
  title: string | null;
  description: string | null;
  stateId: string | null;
  priority: number | null;
  assigneeId: string | null;
  projectId: string | null;
  parentId: string | null;
  labelIds: string[];
  archivedAt: string | null;
}

/** Prefix marking a Kanon ref that had a value but resolved to no linearId. */
export const UNRESOLVED_PREFIX = "!unresolved:";

/** Build a Kanon-ULID → Linear-UUID map from a catalog entity list. */
function linearIdMap(entities: KanonEntity[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const entity of entities) {
    const linearId = entity.data?.linearId;
    if (typeof linearId === "string" && linearId.length > 0) map.set(entity.id, linearId);
  }
  return map;
}

/**
 * Normalize the shadow's issues to the linearId space, resolving every Kanon
 * ULID reference (state/assignee/project/parent/label) to its Linear UUID via
 * the catalog. Issues without a linearId are Kanon-native — counted, not
 * normalized (they can't be joined to Linear).
 */
export function normalizeKanonIssues(
  catalog: KanonCatalog,
  issues: KanonIssue[],
): { issues: NormIssue[]; native: number } {
  const stateMap = linearIdMap(catalog.states);
  const projectMap = linearIdMap(catalog.projects);
  const labelMap = linearIdMap(catalog.labels);
  const actorMap = linearIdMap(catalog.actors);
  const issueMap = linearIdMap(issues); // issue ULID → its own linearId, for parent resolution

  // A present-but-unresolvable Kanon ref (e.g. pointing at a tombstoned entity
  // the catalog filters out) must NOT collapse to "" — that would false-match a
  // Linear side that is legitimately empty (unassigned / no project). Tag it so
  // it can only ever equal itself, surfacing the broken ref as real drift.
  const resolve = (map: Map<string, string>, id: string | null): string =>
    id === null ? "" : (map.get(id) ?? `${UNRESOLVED_PREFIX}${id}`);

  const out: NormIssue[] = [];
  let native = 0;
  for (const issue of issues) {
    const linearId = issue.data?.linearId;
    if (typeof linearId !== "string" || linearId.length === 0) {
      native++;
      continue;
    }
    out.push({
      linearId,
      identifier: issue.identifier ?? "",
      title: issue.title ?? "",
      description: (issue.description ?? "").trim(),
      priority: issue.priority ?? 0,
      stateLinearId: resolve(stateMap, issue.stateId),
      assigneeLinearId: resolve(actorMap, issue.assigneeId),
      projectLinearId: resolve(projectMap, issue.projectId),
      parentLinearId: resolve(issueMap, issue.parentId),
      labelLinearIds: [
        // Unresolvable label ids are tagged, not dropped — a dangling label
        // must change the set (vs Linear's) rather than silently vanish.
        ...new Set(
          (issue.labelIds ?? []).map((id) => labelMap.get(id) ?? `${UNRESOLVED_PREFIX}${id}`),
        ),
      ].sort(),
      archived: issue.archivedAt !== null && issue.archivedAt !== undefined,
    });
  }
  return { issues: out, native };
}
