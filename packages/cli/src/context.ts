/**
 * Repo context — locates the data repo, opens the projection, and provides
 * the ONE write path every lifecycle command uses:
 *
 *   createEvent (@kanon/core) → appendEvents (appendFileSync semantics)
 *   → projection.refresh()
 *
 * The durability rules live in @kanon/store (data-repo.ts) and are shared
 * with the rendezvous server:
 *
 * 1. The post-append refresh is NON-FATAL. Once appendEvents returned, the
 *    write is durable in the canonical log; the SQLite cache is disposable
 *    and rebuilds on the next read. Failing the command AFTER a successful
 *    append would make retrying agents double-create.
 * 2. Display-number allocation is serialized through an O_EXCL lockfile
 *    (meta.json.lock) — `withMetaLock` + `allocateDisplayNumber` in
 *    @kanon/store. This module only adapts them to the CLI (CliError on
 *    lock timeout).
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  createEvent,
  type EventActor,
  type KanonEvent,
  type Model,
  type Op,
  ulid,
} from "@kanon/core";
import {
  appendEvents,
  type DataRepoMeta,
  MetaLockError,
  openProjection,
  type Projection,
  readDataRepoMeta,
  allocateDisplayNumber as storeAllocateDisplayNumber,
  withMetaLock as storeWithMetaLock,
  writeDataRepoMeta,
} from "@kanon/store";
import { CliError, type FlagValue, flagString } from "./args";

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
  return readDataRepoMeta(dir);
}

/** Atomic write (tmp + rename): a crash mid-write can never tear meta.json. */
export function writeMeta(dir: string, meta: DataRepoMeta): void {
  writeDataRepoMeta(dir, meta);
}

/**
 * @kanon/store's meta.json lock, adapted to the CLI: a lock timeout is a
 * user-facing retryable condition (CliError → message + exit 1), not a crash.
 */
export function withMetaLock<T>(dir: string, fn: () => T): T {
  try {
    return storeWithMetaLock(dir, fn);
  } catch (error) {
    if (error instanceof MetaLockError) throw new CliError(error.message);
    throw error;
  }
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

function buildEvents(ctx: RepoContext, inputs: EventInput[]): KanonEvent[] {
  return inputs.map((input) =>
    createEvent({
      workspace: ctx.workspace,
      actor: ctx.actor,
      op: input.op,
      model: input.model,
      modelId: input.modelId ?? ulid(),
      data: input.data,
    }),
  );
}

/**
 * Refresh the projection after a durable append — NON-FATAL. The event log
 * is authoritative; a busy/broken cache rebuilds on the next command.
 * Failing here would exit non-zero after the write landed, and a retrying
 * agent would double-create.
 */
export function safeRefresh(ctx: RepoContext): void {
  try {
    ctx.projection.refresh();
  } catch (error) {
    console.error(
      "warning: projection refresh failed after a durable append — the write IS in the event " +
        "log; the cache rebuilds on the next command (or delete state.db). " +
        `(${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

/** Build events (monotonic ULIDs), append to the log, refresh the projection. */
export function writeEvents(ctx: RepoContext, inputs: EventInput[]): KanonEvent[] {
  const events = buildEvents(ctx, inputs);
  appendEvents(ctx.dir, events);
  safeRefresh(ctx);
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
 * Callers MUST hold the meta lock (use `allocateAndAppend`) — this is a
 * read-modify-write of meta.json. Delegates to @kanon/store (shared with the
 * rendezvous server).
 */
export function allocateDisplayNumber(ctx: RepoContext, teamId: string, teamKey: string): number {
  return storeAllocateDisplayNumber(ctx.dir, ctx.projection.db, teamId, teamKey);
}

/**
 * The number-allocating write path: under the meta lock, allocate the next
 * display number, build the events it parameterizes, and append them —
 * then refresh (non-fatally) outside the lock. Resolve every reference and
 * validate every flag BEFORE calling this: a failure inside would still
 * have advanced the watermark.
 */
export function allocateAndAppend(
  ctx: RepoContext,
  teamId: string,
  teamKey: string,
  inputsFor: (number: number) => EventInput[],
): { number: number; events: KanonEvent[] } {
  const result = withMetaLock(ctx.dir, () => {
    const number = allocateDisplayNumber(ctx, teamId, teamKey);
    const events = buildEvents(ctx, inputsFor(number));
    appendEvents(ctx.dir, events);
    return { number, events };
  });
  safeRefresh(ctx);
  return result;
}
