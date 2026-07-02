/**
 * Reference resolution — the CLI face of the store's resolve helpers.
 * Deterministic order everywhere (ULID → identifier/key → exact name,
 * case-insensitive); zero matches or ambiguity is a hard error that LISTS
 * the candidates, never a silent guess.
 */

import type { Database } from "bun:sqlite";
import {
  type ActorRecord,
  getIssue,
  type IssueRecord,
  listLabels,
  listStates,
  listTeams,
  type MilestoneRecord,
  type ProjectRecord,
  resolveActors,
  resolveLabels,
  resolveMilestones,
  resolveProjects,
  resolveStates,
  resolveTeams,
  type StateRecord,
  type TeamRecord,
} from "@kanon/store";
import { CliError } from "./args";

function describeCandidates(candidates: { id: string; name?: string | null }[]): string {
  return candidates
    .map((candidate) => `${candidate.id}${candidate.name ? ` (${candidate.name})` : ""}`)
    .join(", ");
}

export function requireIssue(db: Database, ref: string): IssueRecord {
  const issue = getIssue(db, ref);
  if (issue === undefined) {
    throw new CliError(`no issue matching "${ref}" (expected a ULID or TEAM-123 identifier)`);
  }
  return issue;
}

export function requireTeam(db: Database, ref: string): TeamRecord {
  const matches = resolveTeams(db, ref);
  if (matches.length === 1 && matches[0] !== undefined) return matches[0];
  if (matches.length === 0) {
    const known = listTeams(db)
      .map((team) => team.key ?? team.id)
      .join(", ");
    throw new CliError(`no team matching "${ref}"${known ? ` — known teams: ${known}` : ""}`);
  }
  throw new CliError(`ambiguous team "${ref}" — candidates: ${describeCandidates(matches)}`);
}

export function requireState(db: Database, ref: string, teamId: string): StateRecord {
  const matches = resolveStates(db, ref, teamId);
  if (matches.length === 1 && matches[0] !== undefined) return matches[0];
  if (matches.length === 0) {
    const known = listStates(db, teamId)
      .map((state) => `${state.name} (${state.stateType})`)
      .join(", ");
    throw new CliError(`no state matching "${ref}"${known ? ` — team states: ${known}` : ""}`);
  }
  throw new CliError(
    `ambiguous state "${ref}" — candidates: ${matches
      .map((state) => `${state.name} (${state.stateType})`)
      .join(", ")} — use the exact name or ULID`,
  );
}

export function requireActor(db: Database, ref: string): ActorRecord {
  const matches = resolveActors(db, ref);
  if (matches.length === 1 && matches[0] !== undefined) return matches[0];
  if (matches.length === 0) {
    throw new CliError(
      `no actor matching "${ref}" (tried ULID, email, name, display name) — ` +
        "actors are minted on first `issue claim` or `issue comment`",
    );
  }
  throw new CliError(`ambiguous actor "${ref}" — candidates: ${describeCandidates(matches)}`);
}

export function requireProject(db: Database, ref: string): ProjectRecord {
  const matches = resolveProjects(db, ref);
  if (matches.length === 1 && matches[0] !== undefined) return matches[0];
  if (matches.length === 0) throw new CliError(`no project matching "${ref}"`);
  throw new CliError(`ambiguous project "${ref}" — candidates: ${describeCandidates(matches)}`);
}

export function requireMilestone(db: Database, ref: string, projectId?: string): MilestoneRecord {
  const matches = resolveMilestones(db, ref, projectId);
  if (matches.length === 1 && matches[0] !== undefined) return matches[0];
  if (matches.length === 0) throw new CliError(`no milestone matching "${ref}"`);
  throw new CliError(`ambiguous milestone "${ref}" — candidates: ${describeCandidates(matches)}`);
}

/** Resolve an existing label; undefined when nothing matches (caller may mint). */
export function findLabel(db: Database, ref: string) {
  const matches = resolveLabels(db, ref);
  if (matches.length > 1) {
    throw new CliError(`ambiguous label "${ref}" — candidates: ${describeCandidates(matches)}`);
  }
  return matches[0];
}

export function requireLabel(db: Database, ref: string) {
  const label = findLabel(db, ref);
  if (label === undefined) {
    const known = listLabels(db)
      .map((entry) => entry.name ?? entry.id)
      .join(", ");
    throw new CliError(`no label matching "${ref}"${known ? ` — known labels: ${known}` : ""}`);
  }
  return label;
}
