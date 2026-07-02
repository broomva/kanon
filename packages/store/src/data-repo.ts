/**
 * Data-repo layout + write path: the per-workspace git repository that holds
 * the canonical event log. Everything else (SQLite, server state, UI state)
 * derives from it.
 *
 *   <repo>/
 *     meta.json            workspace slug, schema version, counter watermark
 *     events/2026-07.jsonl monthly append-only segments
 *     snapshots/           compacted state + cursor (written by compaction)
 *
 * Shared by every writer surface (CLI, rendezvous server): append is a true
 * O_APPEND write, meta.json writes are atomic (tmp + rename), and display-
 * number allocation is serialized through an O_EXCL lockfile
 * (meta.json.lock). Two concurrent writers on ONE clone would otherwise both
 * read watermark N and both mint N+1.
 *
 * Allocation contract: next number = max(displayCounters[key], max number in
 * projection) + 1, watermark persisted back. The projection max includes
 * deleted/archived issues — identifiers are never reused.
 */

import type { Database } from "bun:sqlite";
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  createEvent,
  type EventActor,
  type KanonEvent,
  parseEventLine,
  SCHEMA_VERSION,
  segmentName,
  serializeEvent,
  WORKSPACE_PATTERN,
} from "@kanon/core";

export interface DataRepoMeta {
  workspace: string;
  schemaVersion: typeof SCHEMA_VERSION;
  createdAt: string;
  /** Highest display number ever allocated per team key (BRO → 1651). */
  displayCounters: Record<string, number>;
}

export interface InitOptions {
  dir: string;
  workspace: string;
  actor: EventActor;
  /** Run `git init` in the new data repo (default true; tests disable it). */
  git?: boolean;
}

export interface InitResult {
  meta: DataRepoMeta;
  genesis: KanonEvent;
  gitInitialized: boolean;
}

export function initDataRepo(options: InitOptions): InitResult {
  const { dir, workspace, actor } = options;
  if (!WORKSPACE_PATTERN.test(workspace)) {
    throw new Error(`invalid workspace slug: ${workspace}`);
  }

  mkdirSync(join(dir, "events"), { recursive: true });
  mkdirSync(join(dir, "snapshots"), { recursive: true });
  // Empty dirs don't survive git; keep the layout replicable from a fresh clone.
  writeFileSync(join(dir, "snapshots", ".gitkeep"), "");

  const meta: DataRepoMeta = {
    workspace,
    schemaVersion: SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    displayCounters: {},
  };
  writeFileSync(join(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);

  // Derived caches never enter the log's git history.
  writeFileSync(join(dir, ".gitignore"), "state.db*\n*.sqlite*\n");

  // Concurrent appends to the same monthly segment must UNION on merge, not
  // conflict: replicas each append lines and the ULID sort on load restores
  // the canonical order. This is what makes `kanon sync` (pull --rebase)
  // conflict-free for the log itself.
  writeFileSync(join(dir, ".gitattributes"), "events/*.jsonl merge=union\n");

  const genesis = createEvent({
    workspace,
    actor,
    op: "create",
    model: "workspace",
    data: { slug: workspace },
  });
  appendEvents(dir, [genesis]);

  let gitInitialized = false;
  if (options.git !== false) {
    const proc = Bun.spawnSync(["git", "init", "--quiet"], { cwd: dir });
    gitInitialized = proc.exitCode === 0;
  }

  return { meta, genesis, gitInitialized };
}

export function appendEvents(dir: string, events: KanonEvent[]): void {
  const bySegment = new Map<string, string[]>();
  for (const event of events) {
    const segment = segmentName(event.ts);
    const lines = bySegment.get(segment) ?? [];
    lines.push(serializeEvent(event));
    bySegment.set(segment, lines);
  }
  for (const [segment, lines] of bySegment) {
    // True O_APPEND write: a crash can never truncate committed history the
    // way a read-modify-write could.
    appendFileSync(join(dir, "events", segment), `${lines.join("\n")}\n`);
  }
}

export interface ValidateResult {
  ok: boolean;
  workspace: string;
  eventCount: number;
  errors: string[];
}

export function validateDataRepo(dir: string): ValidateResult {
  const errors: string[] = [];
  let workspace = "";
  let eventCount = 0;

  let meta: DataRepoMeta | undefined;
  try {
    meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as DataRepoMeta;
  } catch (error) {
    errors.push(`meta.json unreadable: ${String(error)}`);
  }
  if (meta) {
    workspace = meta.workspace ?? "";
    if (!WORKSPACE_PATTERN.test(workspace)) {
      errors.push(`meta.json workspace is not a valid slug: ${workspace}`);
    }
    if (meta.schemaVersion !== SCHEMA_VERSION) {
      errors.push(`meta.json schemaVersion ${meta.schemaVersion} != ${SCHEMA_VERSION}`);
    }
  }

  let segments: string[] = [];
  try {
    segments = readdirSync(join(dir, "events")).filter((f) => f.endsWith(".jsonl"));
  } catch (error) {
    errors.push(`events/ unreadable: ${String(error)}`);
  }

  const seen = new Set<string>();
  for (const segment of segments.sort()) {
    const lines = readFileSync(join(dir, "events", segment), "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0);
    for (const [index, line] of lines.entries()) {
      try {
        const event = parseEventLine(line);
        eventCount++;
        if (seen.has(event.id)) {
          errors.push(`${segment}:${index + 1} duplicate event id ${event.id}`);
        }
        seen.add(event.id);
        if (workspace && event.workspace !== workspace) {
          errors.push(`${segment}:${index + 1} event workspace ${event.workspace} != ${workspace}`);
        }
        if (segmentName(event.ts) !== segment) {
          errors.push(`${segment}:${index + 1} event belongs in ${segmentName(event.ts)}`);
        }
      } catch (error) {
        errors.push(`${segment}:${index + 1} ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  return { ok: errors.length === 0, workspace, eventCount, errors };
}

// ---------------------------------------------------------------------------
// meta.json — read / atomic write / lock / display-number allocation
// ---------------------------------------------------------------------------

export function readDataRepoMeta(dir: string): DataRepoMeta {
  return JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as DataRepoMeta;
}

/** Atomic write (tmp + rename): a crash mid-write can never tear meta.json. */
export function writeDataRepoMeta(dir: string, meta: DataRepoMeta): void {
  const path = join(dir, "meta.json");
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(meta, null, 2)}\n`);
  renameSync(tmp, path);
}

const LOCK_STALE_MS = 10_000;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 20;

/** Thrown when the meta.json lock cannot be acquired within the timeout. */
export class MetaLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetaLockError";
  }
}

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
        throw new MetaLockError(
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

/**
 * Allocate the next display number for a team key and persist the watermark.
 * Callers MUST hold the meta lock (`withMetaLock`) — this is a
 * read-modify-write of meta.json. `db` is the open SQLite projection of the
 * same data repo (the projection max keeps sync-imported numbers from being
 * re-minted).
 */
export function allocateDisplayNumber(
  dir: string,
  db: Database,
  teamId: string,
  teamKey: string,
): number {
  const meta = readDataRepoMeta(dir);
  const counters = meta.displayCounters ?? {};
  const watermark = counters[teamKey] ?? 0;
  const row = db
    .query<{ max: number | null }, [string]>(
      "SELECT MAX(number) AS max FROM issues WHERE team_id = ?",
    )
    .get(teamId);
  const projectionMax = row?.max ?? 0;
  const next = Math.max(watermark, projectionMax) + 1;
  counters[teamKey] = next;
  meta.displayCounters = counters;
  writeDataRepoMeta(dir, meta);
  return next;
}
