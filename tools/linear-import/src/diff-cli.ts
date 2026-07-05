#!/usr/bin/env bun
/**
 * mirror-diff — compare the Kanon shadow (:8793 REST) against live Linear and
 * report whether the mirror has converged. READ-ONLY on both sides; this is
 * the BRO-1651 cutover soak gate, never the cutover itself.
 *
 *   bun tools/linear-import/src/diff-cli.ts [--server <url>] [--json]
 *        [--receipt <file>] [--save-report <file>] [--samples <n>]
 *
 * Env: LINEAR_API_KEY (live pull), KANON_API_KEY (shadow bearer),
 *      KANON_SERVER_URL (default http://localhost:8793).
 *
 * Exit: 0 converged · 1 diverged (onlyInLinear or hard mismatches) · 2 error.
 */

import { appendFileSync } from "node:fs";
import {
  type DiffReport,
  diffIssues,
  type KanonCatalog,
  type KanonIssue,
  normalizeKanonIssues,
  normalizeLinearIssue,
} from "./diff";
import { fetchLinearExport } from "./fetch";

const USAGE = `mirror-diff — Kanon shadow vs live Linear convergence check

Usage:
  bun tools/linear-import/src/diff-cli.ts [options]

Options:
  --server <url>       shadow REST base (default $KANON_SERVER_URL or http://localhost:8793)
  --json               print the machine summary (counts + capped samples) to stdout
  --receipt <file>     append a one-line JSON receipt {ts, converged, counts} to <file>
  --save-report <file> write the FULL report (every diff, pretty) to <file>
  --samples <n>        cap per-category samples in --json/human output (default 20)
  --help`;

function fail(message: string): never {
  console.error(`mirror-diff: error: ${message}`);
  process.exit(2);
}

function parseArgs(argv: string[]): Map<string, string | boolean> {
  const value = new Set(["server", "receipt", "save-report", "samples"]);
  const bool = new Set(["json", "help"]);
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined || !arg.startsWith("--")) fail(`unexpected argument: ${arg}`);
    const name = arg.slice(2);
    if (bool.has(name)) {
      flags.set(name, true);
    } else if (value.has(name)) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) fail(`--${name} requires a value`);
      flags.set(name, next);
      i++;
    } else {
      fail(`unknown flag: --${arg.slice(2)}`);
    }
  }
  return flags;
}

async function fetchJson(url: string, key: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    });
  } catch (error) {
    fail(`cannot reach ${url}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) fail(`${url} returned HTTP ${response.status}`);
  return response.json();
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

const flags = parseArgs(process.argv.slice(2));
if (flags.get("help") === true) {
  console.log(USAGE);
  process.exit(0);
}

const server =
  (flags.get("server") as string | undefined) ??
  process.env.KANON_SERVER_URL ??
  "http://localhost:8793";
const kanonKey = process.env.KANON_API_KEY;
if (kanonKey === undefined || kanonKey.length === 0) {
  fail("KANON_API_KEY is required (bearer token for the shadow REST API)");
}
const samples = Number(flags.get("samples") ?? 20);
if (!Number.isInteger(samples) || samples < 0) fail("--samples must be a non-negative integer");

function cap<T>(items: T[]): T[] {
  return items.slice(0, samples);
}

// Everything from here is wrapped so ANY failure — a thrown Linear pull, a
// Kanon fetch, a receipt-write error — exits 2 (error), never 1. That keeps the
// exit-code contract exact (0 converged · 1 diverged · 2 error), which the
// systemd unit's SuccessExitStatus=0 1 relies on: exit 1 must mean ONLY
// "diverged" (a recorded finding), so a broken run can never masquerade as a
// green soak. `process.exit` inside the try terminates before the catch.
try {
  // Linear (source of truth). fetch.ts throws on missing key or a paginated pull failure.
  const linearExport = await fetchLinearExport();
  const linear = linearExport.issues.map(normalizeLinearIssue);

  // Kanon shadow (the mirror) — its own REST read path, exactly what agents see.
  const catalog = (await fetchJson(`${server}/v1/catalog`, kanonKey)) as Partial<KanonCatalog>;
  const issuesBody = (await fetchJson(`${server}/v1/issues`, kanonKey)) as { issues?: unknown };
  const { issues: kanon, native } = normalizeKanonIssues(
    {
      states: asArray(catalog.states) as KanonCatalog["states"],
      projects: asArray(catalog.projects) as KanonCatalog["projects"],
      labels: asArray(catalog.labels) as KanonCatalog["labels"],
      actors: asArray(catalog.actors) as KanonCatalog["actors"],
    },
    asArray(issuesBody.issues) as KanonIssue[],
  );

  const report = diffIssues(linear, kanon, native);
  const ts = new Date().toISOString();

  const summary = {
    ts,
    converged: report.converged,
    linearCount: report.linearCount,
    kanonCount: report.kanonCount,
    kanonNative: report.kanonNative,
    matched: report.matched,
    counts: {
      mismatches: report.mismatches.length,
      descriptionOnly: report.descriptionOnly.length,
      onlyInLinear: report.onlyInLinear.length,
      onlyInKanon: report.onlyInKanon.length,
    },
    samples: {
      mismatches: cap(report.mismatches),
      onlyInLinear: cap(report.onlyInLinear),
      onlyInKanon: cap(report.onlyInKanon),
      descriptionOnly: cap(report.descriptionOnly),
    },
  };

  // Human summary → stderr (journald + terminal), never contaminates --json stdout.
  const verdict = report.converged ? "CONVERGED" : "DIVERGED";
  console.error(
    `mirror-diff: ${verdict} — linear ${report.linearCount} · kanon ${report.kanonCount} ` +
      `(+${report.kanonNative} native) · matched ${report.matched}`,
  );
  console.error(
    `  drift: ${report.mismatches.length} field-mismatch · ${report.onlyInLinear.length} missing-from-shadow` +
      ` · soft: ${report.descriptionOnly.length} description-only · ${report.onlyInKanon.length} only-in-shadow`,
  );
  for (const m of cap(report.mismatches)) {
    console.error(`  ✗ ${m.identifier}: ${m.fields.map((f) => f.field).join(", ")}`);
  }
  for (const o of cap(report.onlyInLinear)) {
    console.error(`  ✗ missing from shadow: ${o.identifier}`);
  }

  if (typeof flags.get("save-report") === "string") {
    const full: DiffReport & { ts: string } = { ts, ...report };
    await Bun.write(flags.get("save-report") as string, `${JSON.stringify(full, null, 2)}\n`);
  }
  if (typeof flags.get("receipt") === "string") {
    const line = JSON.stringify({
      ts,
      converged: report.converged,
      linearCount: report.linearCount,
      kanonCount: report.kanonCount,
      kanonNative: report.kanonNative,
      matched: report.matched,
      ...summary.counts,
    });
    // True append — never read-modify-write the whole receipt log.
    appendFileSync(flags.get("receipt") as string, `${line}\n`);
  }
  if (flags.get("json") === true) {
    console.log(JSON.stringify(summary, null, 2));
  }

  process.exit(report.converged ? 0 : 1);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
