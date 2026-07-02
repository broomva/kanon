#!/usr/bin/env bun

/**
 * kanon — CLI for the agent-native work tracker.
 *
 * M1 surface: full issue lifecycle over the append-only event log with a
 * SQLite projection (@kanon/store) as the disposable read cache. Every read
 * command takes --json for agent consumption; every write is
 * createEvent → appendEvents → projection.refresh().
 *
 * The data repo for lifecycle commands resolves --repo → KANON_REPO → cwd.
 * Actor identity: KANON_ACTOR (+ KANON_ACTOR_TYPE, KANON_SESSION) → git
 * config user.email → user@host.
 */

import { SQLiteError } from "bun:sqlite";
import { resolve } from "node:path";
import { initDataRepo, validateDataRepo } from "@kanon/store";
import { resolveActor } from "./actor";
import { CliError, flagBool, parseFlags, requireFlag } from "./args";
import { doctor } from "./commands/doctor";
import {
  issueArchive,
  issueClaim,
  issueComment,
  issueCreate,
  issueList,
  issueReady,
  issueRelate,
  issueShow,
  issueUnrelate,
  issueUpdate,
} from "./commands/issue";
import { logCommand } from "./commands/log";
import { milestoneCreate, milestoneList, projectCreate, projectList } from "./commands/project";
import { sync } from "./commands/sync";
import { teamCreate, teamList } from "./commands/team";

const VERSION = "0.2.0";

const USAGE = `kanon ${VERSION} — agent-native work tracker

Usage:
  kanon init <dir> --workspace <slug> [--no-git] [--json]
  kanon validate <dir> [--json]

  kanon team create --key BRO --name Broomva
  kanon team list

  kanon issue create --team BRO --title ... [--description --priority 0-4
        --estimate N --assignee REF --delegate REF --project REF
        --milestone REF --parent REF --label a --label b]
  kanon issue show <ref>
  kanon issue list [--team --state --assignee --delegate --project --label
        --priority --parent --updated-after --updated-before --query
        --no-archived --order-by createdAt|updatedAt --order-dir asc|desc
        --limit N --offset N]
  kanon issue ready [--team BRO]
  kanon issue update <ref> [--state --title --description --priority
        --estimate --assignee --delegate --add-label --remove-label]
  kanon issue claim <ref>
  kanon issue archive <ref>
  kanon issue comment <ref> --body ...
  kanon issue relate <ref> --blocks <ref2> | --blocked-by <ref2> | --related-to <ref2>
  kanon issue unrelate <ref> --blocks <ref2> | --blocked-by <ref2> | --related-to <ref2>

  kanon project create --name ... [--description --target-date]
  kanon project list
  kanon milestone create --name ... --project <ref> [--target-date]
  kanon milestone list [--project <ref>]

  kanon sync                    add + commit + pull --rebase + push
  kanon doctor                  repair duplicate identifiers + watermarks
  kanon log [--limit N]         last N events, human-readable

Lifecycle commands take --repo <dir> (default: $KANON_REPO, then cwd) and
--json. <ref> is a ULID or a display identifier like BRO-123.

The <dir> is a per-workspace data repo: an append-only event log carried by
git. Stores derive from it; they are never the source of truth.`;

function runInit(argv: string[]): void {
  const { positionals, flags } = parseFlags(
    argv,
    { workspace: "value", "no-git": "boolean", json: "boolean" },
    { min: 1, max: 1, usage: "kanon init <dir> --workspace <slug> [--no-git] [--json]" },
  );
  const dirArg = positionals[0];
  if (dirArg === undefined) throw new CliError("init requires a <dir>");
  const workspace = requireFlag(flags, "workspace");
  const dir = resolve(dirArg);
  const result = initDataRepo({
    dir,
    workspace,
    actor: resolveActor(),
    git: !flagBool(flags, "no-git"),
  });
  if (flagBool(flags, "json")) {
    console.log(JSON.stringify({ dir, ...result }, null, 2));
  } else {
    console.log(`initialized kanon data repo for workspace "${workspace}" at ${dir}`);
    console.log(`  genesis event ${result.genesis.id}`);
    console.log(`  git: ${result.gitInitialized ? "initialized" : "skipped"}`);
  }
}

function runValidate(argv: string[]): void {
  const { positionals, flags } = parseFlags(
    argv,
    { json: "boolean" },
    { min: 1, max: 1, usage: "kanon validate <dir> [--json]" },
  );
  const dirArg = positionals[0];
  if (dirArg === undefined) throw new CliError("validate requires a <dir>");
  const result = validateDataRepo(resolve(dirArg));
  if (flagBool(flags, "json")) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.ok) {
    console.log(`ok: workspace "${result.workspace}", ${result.eventCount} event(s)`);
  } else {
    console.error(`invalid data repo (${result.errors.length} error(s)):`);
    for (const error of result.errors) console.error(`  - ${error}`);
  }
  if (!result.ok) process.exit(1);
}

type Handler = (argv: string[]) => void;

const SUBCOMMANDS: Record<string, Record<string, Handler>> = {
  team: { create: teamCreate, list: teamList },
  issue: {
    create: issueCreate,
    show: issueShow,
    list: issueList,
    ready: issueReady,
    update: issueUpdate,
    claim: issueClaim,
    archive: issueArchive,
    comment: issueComment,
    relate: issueRelate,
    unrelate: issueUnrelate,
  },
  project: { create: projectCreate, list: projectList },
  milestone: { create: milestoneCreate, list: milestoneList },
};

function main(argv: string[]): void {
  const [command, ...rest] = argv;
  const group = command === undefined ? undefined : SUBCOMMANDS[command];
  if (group !== undefined) {
    const [subcommand, ...subRest] = rest;
    const handler = subcommand === undefined ? undefined : group[subcommand];
    if (handler === undefined) {
      throw new CliError(
        `unknown subcommand: kanon ${command} ${subcommand ?? ""} — ` +
          `expected one of: ${Object.keys(group).join(", ")}`,
      );
    }
    handler(subRest);
    return;
  }
  switch (command) {
    case "init":
      runInit(rest);
      break;
    case "validate":
      runValidate(rest);
      break;
    case "sync":
      sync(rest);
      break;
    case "doctor":
      doctor(rest);
      break;
    case "log":
      logCommand(rest);
      break;
    case "--version":
    case "version":
      console.log(VERSION);
      break;
    case undefined:
    case "help":
    case "--help":
      console.log(USAGE);
      break;
    default:
      console.log(USAGE);
      process.exit(1);
  }
}

try {
  main(process.argv.slice(2));
} catch (error) {
  if (error instanceof CliError) {
    console.error(`error: ${error.message}`);
    process.exit(1);
  }
  if (error instanceof SQLiteError) {
    // The cache, not the log: state.db is disposable and every append is
    // durable before any projection write happens. No stack trace — this is
    // a retryable condition, not a crash.
    console.error(
      `error: the projection cache is busy or unavailable (${error.message}). ` +
        "The event log is unaffected — retry the command; if it persists, delete " +
        "state.db in the data repo (it rebuilds from the log).",
    );
    process.exit(1);
  }
  throw error;
}
