#!/usr/bin/env bun
/**
 * linear-import — one-shot Linear → Kanon data-repo importer.
 *
 * The data repo must already be initialized (`kanon init <dir> --workspace
 * <slug>`); the repo's meta.json workspace is canonical, so if the export
 * carries a different slug the import rewrites events to the repo's slug and
 * says so. Re-runs are idempotent: entities already in the log (matched by
 * data.linearId) are skipped; issues whose Linear updatedAt moved get exactly
 * one update event. After a real (non-dry-run) import the repo's meta.json
 * displayCounters are seeded with the highest imported issue number per team
 * key, so locally minted identifiers continue above imported history.
 *
 * Operational limits are documented in tools/linear-import/README.md.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { CliError, normalizeExport, parseArgs } from "./cli";
import { appendEvents, buildIdMap, loadEvents, seedDisplayCounters } from "./data-repo";
import { fetchLinearExport } from "./fetch";
import { displayCounters, transform } from "./transform";
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
  --dry-run          transform and report, but write nothing
  --json             machine-readable summary on stdout`;

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function readExportFile(path: string): LinearExport {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    fail(`cannot read fixture ${path}: ${error instanceof Error ? error.message : error}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(`fixture ${path} is not valid JSON: ${error instanceof Error ? error.message : error}`);
  }
  return normalizeExport(parsed);
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

let flags: Map<string, string | boolean>;
try {
  flags = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(USAGE);
  console.error("");
  fail(error instanceof Error ? error.message : String(error));
}

if (flags.get("help") === true) {
  console.log(USAGE);
  process.exit(0);
}

const dataRepoArg = flags.get("data-repo");
if (typeof dataRepoArg !== "string") {
  console.error(USAGE);
  console.error("");
  fail("--data-repo <dir> is required");
}
const dataRepo = resolve(dataRepoArg);

const fixtureArg = flags.get("fixture");
const live = flags.get("live") === true;
if (live === (typeof fixtureArg === "string")) {
  fail("exactly one of --fixture <export.json> or --live is required");
}

let exportData: LinearExport;
try {
  exportData =
    typeof fixtureArg === "string"
      ? readExportFile(resolve(fixtureArg))
      : normalizeExport(await fetchLinearExport());
} catch (error) {
  if (error instanceof CliError) fail(error.message);
  throw error;
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
if (!dryRun) {
  if (events.length > 0) appendEvents(dataRepo, events);
  seedDisplayCounters(dataRepo, displayCounters(exportData));
}

if (summary.droppedRefs.length > 0) {
  console.error(`warning: ${summary.droppedRefs.length} unresolvable cross-reference(s) dropped:`);
  for (const drop of summary.droppedRefs) {
    console.error(`  ${drop.model} ${drop.linearId} .${drop.field} → ${drop.ref}`);
  }
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
  if (summary.droppedRefs.length > 0) {
    console.log(`  dropped refs: ${summary.droppedRefs.length} (see warning above)`);
  }
}
