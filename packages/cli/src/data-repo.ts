/**
 * Data-repo layout: the per-workspace git repository that holds the canonical
 * event log. Everything else (SQLite, Postgres, UI state) derives from it.
 *
 *   <repo>/
 *     meta.json            workspace slug, schema version, counter watermark
 *     events/2026-07.jsonl monthly append-only segments
 *     snapshots/           compacted state + cursor (written by compaction, M1)
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
  writeFileSync(join(dir, ".gitignore"), "state.db\n*.sqlite*\n");

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
    const path = join(dir, "events", segment);
    let existing = "";
    try {
      existing = readFileSync(path, "utf8");
    } catch {
      // First event in this segment.
    }
    writeFileSync(path, `${existing}${lines.join("\n")}\n`);
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
