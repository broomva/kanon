/**
 * `kanon team create|list` — teams and their default workflow.
 *
 * `team create` seeds the 7 default workflow states (Linear's canonical
 * set): Triage/triage, Backlog/backlog, Todo/unstarted, In Progress/started,
 * Done/completed, Canceled/canceled, Duplicate/canceled.
 */

import { ulid } from "@kanon/core";
import { listStates, listTeams, resolveTeams } from "@kanon/store";
import { resolveActor } from "../actor";
import { CliError, flagBool, parseFlags, requireFlag } from "../args";
import { openRepo, writeEvents } from "../context";
import { emit } from "../output";

/** Identifier charset: keys become the TEAM half of TEAM-123, forever. */
export const TEAM_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/;

export const DEFAULT_STATES = [
  { name: "Triage", type: "triage", color: "#8a8f98", position: 0 },
  { name: "Backlog", type: "backlog", color: "#bec2c8", position: 1 },
  { name: "Todo", type: "unstarted", color: "#e2e2e2", position: 2 },
  { name: "In Progress", type: "started", color: "#f2c94c", position: 3 },
  { name: "Done", type: "completed", color: "#5e6ad2", position: 4 },
  { name: "Canceled", type: "canceled", color: "#95a2b3", position: 5 },
  { name: "Duplicate", type: "canceled", color: "#95a2b3", position: 6 },
] as const;

const COMMON = { json: "boolean", repo: "value" } as const;

export function teamCreate(argv: string[]): void {
  const { flags } = parseFlags(
    argv,
    { ...COMMON, key: "value", name: "value" },
    { min: 0, max: 0, usage: "kanon team create --key BRO --name Broomva" },
  );
  const key = requireFlag(flags, "key");
  const name = requireFlag(flags, "name");
  // Keys form display identifiers (BRO-123) and are forever — enforce the
  // identifier charset at the door, not after a thousand issues exist.
  if (!TEAM_KEY_PATTERN.test(key)) {
    throw new CliError(
      `--key must be a letter followed by letters/digits (${TEAM_KEY_PATTERN}) — got "${key}"`,
    );
  }
  const ctx = openRepo(flags, resolveActor());

  const existing = resolveTeams(ctx.projection.db, key);
  if (existing.length > 0) {
    throw new CliError(`team key "${key}" already exists (${existing[0]?.id})`);
  }

  const teamId = ulid();
  writeEvents(ctx, [
    { op: "create", model: "team", modelId: teamId, data: { key, name } },
    ...DEFAULT_STATES.map((state) => ({
      op: "create" as const,
      model: "workflow_state" as const,
      data: {
        teamId,
        name: state.name,
        type: state.type,
        color: state.color,
        position: state.position,
      },
    })),
  ]);

  const states = listStates(ctx.projection.db, teamId);
  emit(flagBool(flags, "json"), { id: teamId, key, name, states }, () => {
    console.log(`created team ${key} — ${name} (${teamId})`);
    console.log(
      `  seeded ${states.length} workflow states: ${states.map((s) => s.name).join(", ")}`,
    );
  });
  ctx.projection.close();
}

export function teamList(argv: string[]): void {
  const { flags } = parseFlags(argv, COMMON, { min: 0, max: 0, usage: "kanon team list" });
  const ctx = openRepo(flags, resolveActor());
  const teams = listTeams(ctx.projection.db);
  emit(flagBool(flags, "json"), teams, () => {
    if (teams.length === 0) {
      console.log("no teams — create one with: kanon team create --key BRO --name Broomva");
      return;
    }
    for (const team of teams) {
      console.log(`${team.key ?? "??"}  ${team.name ?? ""}  (${team.id})`);
    }
  });
  ctx.projection.close();
}
