#!/usr/bin/env bun
/**
 * linear-import — one-shot Linear → Kanon data-repo importer.
 *
 * The data repo must already be initialized (`kanon init <dir> --workspace
 * <slug>`); the repo's meta.json workspace is canonical, so if the export
 * carries a different slug the import rewrites events to the repo's slug and
 * says so. Re-runs are idempotent: entities already in the log (matched by
 * data.linearId) are skipped; issues whose Linear updatedAt moved get exactly
 * one update event.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { appendEvents, buildIdMap, loadEvents } from "./data-repo";
import { fetchLinearExport } from "./fetch";
import { transform } from "./transform";
import type { LinearExport } from "./types";

const USAGE = `linear-import — import a Linear workspace into a Kanon data repo

Usage:
  bun tools/linear-import/src/index.ts --data-repo <dir> (--fixture <export.json> | --live)
       [--save-export <file>] [--dry-run] [--json]

Modes:
  --fixture <file>   transform a saved LinearExport JSON snapshot
  --live             pull from the Linear API (requires LINEAR_API_KEY)

Options:
  --save-export <f>  write the (live or fixture) export snapshot to <f>
  --dry-run          transform and report, but append nothing
  --json             machine-readable summary on stdout`;

const BOOLEAN_FLAGS = new Set(["live", "dry-run", "json", "help"]);

function parseArgs(argv: string[]): Map<string, string | boolean> {
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined || !arg.startsWith("--")) continue;
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (!BOOLEAN_FLAGS.has(name) && next !== undefined && !next.startsWith("--")) {
      flags.set(name, next);
      i++;
    } else {
      flags.set(name, true);
    }
  }
  return flags;
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function normalizeExport(value: unknown): LinearExport {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("export must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.workspace !== "string") {
    fail("export.workspace must be a string");
  }
  const list = (key: string): unknown[] => {
    const raw = record[key];
    return Array.isArray(raw) ? raw : [];
  };
  return {
    workspace: record.workspace,
    teams: list("teams"),
    labels: list("labels"),
    users: list("users"),
    projects: list("projects"),
    milestones: list("milestones"),
    initiatives: list("initiatives"),
    issues: list("issues"),
    comments: list("comments"),
  } as LinearExport;
}

function readExportFile(path: string): LinearExport {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    fail(`cannot read fixture ${path}: ${error instanceof Error ? error.message : error}`);
  }
  try {
    return normalizeExport(JSON.parse(raw));
  } catch (error) {
    fail(`fixture ${path} is not valid JSON: ${error instanceof Error ? error.message : error}`);
  }
}

function readMetaWorkspace(dir: string): string {
  let meta: unknown;
  try {
    meta = JSON.parse(readFileSync(resolve(dir, "meta.json"), "utf8"));
  } catch {
    fail(`${dir} is not a kanon data repo (missing meta.json — run \`kanon init\` first)`);
  }
  const workspace = (meta as Record<string, unknown>).workspace;
  if (typeof workspace !== "string") {
    fail(`${dir}/meta.json has no workspace slug`);
  }
  return workspace;
}

const flags = parseArgs(process.argv.slice(2));

if (flags.get("help") === true) {
  console.log(USAGE);
  process.exit(0);
}

const dataRepoArg = flags.get("data-repo");
if (typeof dataRepoArg !== "string") {
  console.error(USAGE);
  fail("--data-repo <dir> is required");
}
const dataRepo = resolve(dataRepoArg);

const fixtureArg = flags.get("fixture");
const live = flags.get("live") === true;
if (live === (typeof fixtureArg === "string")) {
  fail("exactly one of --fixture <export.json> or --live is required");
}

let exportData: LinearExport;
if (typeof fixtureArg === "string") {
  exportData = readExportFile(resolve(fixtureArg));
} else {
  exportData = await fetchLinearExport();
}

const saveExport = flags.get("save-export");
if (typeof saveExport === "string") {
  writeFileSync(resolve(saveExport), `${JSON.stringify(exportData, null, 2)}\n`);
  console.error(`saved export snapshot to ${resolve(saveExport)}`);
}

const repoWorkspace = readMetaWorkspace(dataRepo);
if (repoWorkspace !== exportData.workspace) {
  console.error(
    `note: export workspace "${exportData.workspace}" != data-repo workspace ` +
      `"${repoWorkspace}"; events use "${repoWorkspace}"`,
  );
  exportData = { ...exportData, workspace: repoWorkspace };
}

const existingEvents = loadEvents(dataRepo);
const idMap = buildIdMap(existingEvents);
const { events, summary } = transform(exportData, idMap);

const dryRun = flags.get("dry-run") === true;
if (!dryRun && events.length > 0) {
  appendEvents(dataRepo, events);
}

if (flags.get("json") === true) {
  console.log(
    JSON.stringify(
      {
        dataRepo,
        dryRun,
        events: events.length,
        appended: dryRun ? 0 : events.length,
        summary,
      },
      null,
      2,
    ),
  );
} else {
  const verb = dryRun ? "would append" : "appended";
  console.log(`linear-import: ${verb} ${events.length} event(s) to ${dataRepo}`);
  console.log(
    `  created ${summary.created} · updated ${summary.updated} · skipped ${summary.skipped}`,
  );
  for (const [model, counts] of Object.entries(summary.byModel)) {
    const parts = (["created", "updated", "skipped"] as const)
      .filter((kind) => counts[kind] > 0)
      .map((kind) => `${counts[kind]} ${kind}`);
    console.log(`  ${model}: ${parts.join(", ")}`);
  }
}
