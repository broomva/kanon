/**
 * CLI plumbing for linear-import, split from index.ts so it is unit-testable:
 * strict flag parsing (unknown flags and missing values are hard errors, never
 * silently ignored) and fail-fast export validation (a malformed export must
 * be rejected before ANY write — a missing linearId would otherwise mint a
 * duplicate entity on every re-run).
 */

import type { LinearExport } from "./types";

/** A user-input error: index.ts prints usage + message and exits 1. */
export class CliError extends Error {}

export const VALUE_FLAGS = new Set(["data-repo", "fixture", "save-export"]);
export const BOOLEAN_FLAGS = new Set(["live", "dry-run", "json", "help"]);

/**
 * Strict flag parser. Rejects unknown flags (a `--dryrun` typo must not
 * silently import), non-flag arguments, boolean flags given a value via `=`,
 * and value flags missing their value (`--save-export --dry-run` must not
 * silently lose the export).
 */
export function parseArgs(argv: string[]): Map<string, string | boolean> {
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (!arg.startsWith("--")) {
      throw new CliError(`unexpected argument: ${arg}`);
    }
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    const name = eq === -1 ? body : body.slice(0, eq);
    const inline = eq === -1 ? undefined : body.slice(eq + 1);

    if (BOOLEAN_FLAGS.has(name)) {
      if (inline !== undefined) {
        throw new CliError(`--${name} does not take a value`);
      }
      flags.set(name, true);
      continue;
    }
    if (VALUE_FLAGS.has(name)) {
      if (inline !== undefined) {
        if (inline.length === 0) throw new CliError(`--${name} requires a value`);
        flags.set(name, inline);
        continue;
      }
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new CliError(`--${name} requires a value`);
      }
      flags.set(name, next);
      i++;
      continue;
    }
    throw new CliError(`unknown flag: --${name}`);
  }
  return flags;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function itemList(record: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const raw = record[key];
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new CliError(`export.${key} must be an array`);
  }
  return raw.map((item, index) => {
    if (!isRecord(item)) {
      throw new CliError(`export.${key}[${index}] must be an object`);
    }
    return item;
  });
}

function requireString(
  item: Record<string, unknown>,
  field: string,
  where: string,
  optional = false,
): void {
  const value = item[field];
  if (optional && value === undefined) return;
  if (typeof value !== "string" || value.length === 0) {
    throw new CliError(`${where}: ${field} must be a non-empty string`);
  }
}

function requireParseableTs(
  item: Record<string, unknown>,
  field: string,
  where: string,
  optional = false,
): void {
  const value = item[field];
  if (optional && value === undefined) return;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new CliError(`${where}: ${field} must be a parseable timestamp (got ${String(value)})`);
  }
}

/**
 * Validate an untrusted export document into a LinearExport, failing fast on
 * the defects that would corrupt the log: missing/empty linearIds (⇒ duplicate
 * entities on re-run), issues without teamLinearId/number (⇒ broken display
 * identity), and unparseable timestamps (⇒ garbage segment names, wrong-month
 * routing). Runs BEFORE any write.
 */
export function normalizeExport(value: unknown): LinearExport {
  if (!isRecord(value)) {
    throw new CliError("export must be a JSON object");
  }
  if (typeof value.workspace !== "string" || value.workspace.length === 0) {
    throw new CliError("export.workspace must be a non-empty string");
  }

  const lists: Record<string, Record<string, unknown>[]> = {};
  for (const key of [
    "teams",
    "labels",
    "users",
    "projects",
    "milestones",
    "initiatives",
    "issues",
    "comments",
  ]) {
    const items = itemList(value, key);
    for (const [index, item] of items.entries()) {
      const where = `export.${key}[${index}]`;
      requireString(item, "linearId", where);
    }
    lists[key] = items;
  }

  for (const [index, team] of (lists.teams ?? []).entries()) {
    const states = team.states;
    if (states === undefined) continue;
    if (!Array.isArray(states)) {
      throw new CliError(`export.teams[${index}].states must be an array`);
    }
    for (const [stateIndex, state] of states.entries()) {
      const where = `export.teams[${index}].states[${stateIndex}]`;
      if (!isRecord(state)) throw new CliError(`${where} must be an object`);
      requireString(state, "linearId", where);
    }
  }

  for (const [index, issue] of (lists.issues ?? []).entries()) {
    const where = `export.issues[${index}] (${String(issue.linearId)})`;
    requireString(issue, "teamLinearId", where);
    if (typeof issue.number !== "number") {
      throw new CliError(`${where}: number must be a number`);
    }
    requireParseableTs(issue, "createdAt", where);
    requireParseableTs(issue, "updatedAt", where);
    requireParseableTs(issue, "archivedAt", where, true);
  }

  for (const [index, comment] of (lists.comments ?? []).entries()) {
    const where = `export.comments[${index}] (${String(comment.linearId)})`;
    requireString(comment, "issueLinearId", where);
    requireParseableTs(comment, "createdAt", where);
  }

  return {
    workspace: value.workspace,
    teams: lists.teams,
    labels: lists.labels,
    users: lists.users,
    projects: lists.projects,
    milestones: lists.milestones,
    initiatives: lists.initiatives,
    issues: lists.issues,
    comments: lists.comments,
  } as unknown as LinearExport;
}
