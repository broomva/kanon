/**
 * Repo context — locates the data repo, opens the projection, and provides
 * the ONE write path every lifecycle command uses:
 *
 *   createEvent (@kanon/core) → appendEvents (appendFileSync semantics)
 *   → projection.refresh()
 *
 * Two durability rules live here:
 *
 * 1. The post-append refresh is NON-FATAL. Once appendEvents returned, the
 *    write is durable in the canonical log; the SQLite cache is disposable
 *    and rebuilds on the next read. Failing the command AFTER a successful
 *    append would make retrying agents double-create.
 * 2. Display-number allocation is serialized through an O_EXCL lockfile
 *    (meta.json.lock). meta.json is a read-modify-write watermark, so two
 *    concurrent `issue create` processes on ONE clone would otherwise both
 *    read watermark N and both mint N+1. The lock covers allocate→append;
 *    meta writes are atomic (tmp + rename) so a crash never tears the file.
 *
 * Contract: next number = max(displayCounters[key], max number in
 * projection) + 1, watermark persisted back. The projection max includes
 * deleted/archived issues — identifiers are never reused.
 */

import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
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

/** Atomic write (tmp + rename): a crash mid-write can never tear meta.json. */
export function writeMeta(dir: string, meta: DataRepoMeta): void {
  const path = join(dir, "meta.json");
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(meta, null, 2)}\n`);
  renameSync(tmp, path);
}

const LOCK_STALE_MS = 10_000;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 20;

/**
 * Serialize meta.json read-modify-write across concurrent kanon processes
 * on the same clone: O_EXCL lockfile with retry, timeout, and stale-lock
 * detection by age (a crashed holder never wedges the repo for good).
 */
export function withMetaLock<T>(dir: string, fn: () => T): T {
  const lockPath = join(dir, "meta.json.lock");
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      writeFileSync(lockPath, `${process.pid}\n`, { flag: "wx" });
      break;
    } catch {
      try {
        const age = Date.now() - statSync(lockPath).mtimeMs;
        if (age > LOCK_STALE_MS) {
          rmSync(lockPath, { force: true }); // crashed holder — reclaim
          continue;
        }
      } catch {
        continue; // lock vanished between attempts — retry immediately
      }
      if (Date.now() > deadline) {
        throw new CliError(
          `could not acquire ${lockPath} within ${LOCK_TIMEOUT_MS}ms — another kanon process ` +
            "is allocating; retry, or delete the lock file if its holder crashed",
        );
      }
      Bun.sleepSync(LOCK_RETRY_MS);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lockPath, { force: true });
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
 * read-modify-write of meta.json.
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
