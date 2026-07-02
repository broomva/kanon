#!/usr/bin/env bun
/**
 * kanon — CLI for the agent-native work tracker.
 *
 * M0 surface: `init` and `validate`. Issue lifecycle commands land in M1
 * (BRO-1646). Every read command takes --json for agent consumption.
 */

import { hostname, userInfo } from "node:os";
import { resolve } from "node:path";
import type { EventActor } from "@kanon/core";
import { initDataRepo, validateDataRepo } from "./data-repo";

const VERSION = "0.1.0";

const USAGE = `kanon ${VERSION} — agent-native work tracker

Usage:
  kanon init <dir> --workspace <slug> [--no-git] [--json]
  kanon validate <dir> [--json]
  kanon --version

The <dir> is a per-workspace data repo: an append-only event log carried by
git. Stores derive from it; they are never the source of truth.`;

interface ParsedArgs {
  command: string | undefined;
  positional: string[];
  flags: Map<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === undefined) break;
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(name, next);
        i++;
      } else {
        flags.set(name, true);
      }
    } else {
      positional.push(arg);
    }
  }
  return { command, positional, flags };
}

function cliActor(): EventActor {
  return {
    type: "human",
    id: process.env.KANON_ACTOR ?? `${userInfo().username}@${hostname()}`,
    surface: "cli",
  };
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

const { command, positional, flags } = parseArgs(process.argv.slice(2));
const json = flags.get("json") === true;

switch (command) {
  case "init": {
    const dirArg = positional[0] ?? fail("init requires a <dir>");
    const workspace = flags.get("workspace");
    if (typeof workspace !== "string") fail("init requires --workspace <slug>");
    const dir = resolve(dirArg);
    const result = initDataRepo({
      dir,
      workspace,
      actor: cliActor(),
      git: flags.get("no-git") !== true,
    });
    if (json) {
      console.log(JSON.stringify({ dir, ...result }, null, 2));
    } else {
      console.log(`initialized kanon data repo for workspace "${workspace}" at ${dir}`);
      console.log(`  genesis event ${result.genesis.id}`);
      console.log(`  git: ${result.gitInitialized ? "initialized" : "skipped"}`);
    }
    break;
  }
  case "validate": {
    const dirArg = positional[0] ?? fail("validate requires a <dir>");
    const result = validateDataRepo(resolve(dirArg));
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.ok) {
      console.log(`ok: workspace "${result.workspace}", ${result.eventCount} event(s)`);
    } else {
      console.error(`invalid data repo (${result.errors.length} error(s)):`);
      for (const error of result.errors) console.error(`  - ${error}`);
    }
    if (!result.ok) process.exit(1);
    break;
  }
  case "--version":
  case "version":
    console.log(VERSION);
    break;
  default:
    console.log(USAGE);
    if (command !== undefined && command !== "--help" && command !== "help") {
      process.exit(1);
    }
}
