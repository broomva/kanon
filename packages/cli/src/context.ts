/**
 * Repo context — locates the data repo, opens the projection, and provides
 * the ONE write path every lifecycle command uses:
 *
 *   createEvent (@kanon/core) → appendEvents (appendFileSync semantics)
 *   → projection.refresh()
 *
 * Display-number allocation follows the displayCounters contract: next =
 * max(meta.displayCounters[key], max number in projection) + 1, and the new
 * watermark is persisted back to meta.json. The projection max includes
 * deleted/archived issues — identifiers are never reused.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createEvent,
  type EventActor,
  type KanonEvent,
  type Model,
  type Op,
  ulid,
} from "@kanon/core";
import { openProjection, type Projection } from "@kanon/store";
import { CliError, type FlagValue, flagString } from "./args";
import { appendEvents, type DataRepoMeta } from "./data-repo";

export interface RepoContext {
  dir: string;
  workspace: string;
  projection: Projection;
  actor: EventActor;
}

/** Resolve the data repo dir: --repo flag → KANON_REPO env → cwd. */
export function resolveRepoDir(flags: Map<string, FlagValue>): string {
  const flagDir = flagString(flags, "repo");
  const dir = resolve(flagDir ?? process.env.KANON_REPO ?? process.cwd());
  if (!existsSync(`${dir}/meta.json`)) {
    throw new CliError(
      `not a kanon data repo (no meta.json): ${dir} — pass --repo <dir> or set KANON_REPO`,
    );
  }
  return dir;
}

export function readMeta(dir: string): DataRepoMeta {
  return JSON.parse(readFileSync(`${dir}/meta.json`, "utf8")) as DataRepoMeta;
}

export function writeMeta(dir: string, meta: DataRepoMeta): void {
  writeFileSync(`${dir}/meta.json`, `${JSON.stringify(meta, null, 2)}\n`);
}

export function openRepo(flags: Map<string, FlagValue>, actor: EventActor): RepoContext {
  const dir = resolveRepoDir(flags);
  const meta = readMeta(dir);
  const projection = openProjection(dir, {
    onWarn: (message) => console.error(`warning: ${message}`),
  });
  projection.refresh();
  return { dir, workspace: meta.workspace, projection, actor };
}

export interface EventInput {
  op: Op;
  model: Model;
  modelId?: string;
  data: Record<string, unknown>;
}

/** Build events (monotonic ULIDs), append to the log, refresh the projection. */
export function writeEvents(ctx: RepoContext, inputs: EventInput[]): KanonEvent[] {
  const events = inputs.map((input) =>
    createEvent({
      workspace: ctx.workspace,
      actor: ctx.actor,
      op: input.op,
      model: input.model,
      modelId: input.modelId ?? ulid(),
      data: input.data,
    }),
  );
  appendEvents(ctx.dir, events);
  ctx.projection.refresh();
  return events;
}

export function writeEvent(ctx: RepoContext, input: EventInput): KanonEvent {
  const [event] = writeEvents(ctx, [input]);
  if (event === undefined) throw new Error("unreachable: writeEvents dropped an event");
  return event;
}

/** Drop undefined values so event data stays JSON-safe and compact. */
export function compact(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Allocate the next display number for a team key and persist the watermark.
 * Contract: max(displayCounters[key], max number in projection) + 1 — the
 * projection max covers numbers imported or synced in without a local
 * watermark; the counter covers numbers allocated but not yet projected.
 */
export function allocateDisplayNumber(ctx: RepoContext, teamId: string, teamKey: string): number {
  const meta = readMeta(ctx.dir);
  const counters = meta.displayCounters ?? {};
  const watermark = counters[teamKey] ?? 0;
  const row = ctx.projection.db
    .query<{ max: number | null }, [string]>(
      "SELECT MAX(number) AS max FROM issues WHERE team_id = ?",
    )
    .get(teamId);
  const projectionMax = row?.max ?? 0;
  const next = Math.max(watermark, projectionMax) + 1;
  counters[teamKey] = next;
  meta.displayCounters = counters;
  writeMeta(ctx.dir, meta);
  return next;
}
