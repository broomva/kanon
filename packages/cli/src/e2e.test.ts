/**
 * End-to-end CLI tests — every scenario drives the real binary entry point
 * (`bun src/index.ts ...`) in temp dirs, exactly as an agent would.
 *
 * The two-clone convergence test is the M1 acceptance test: a bare origin,
 * two clones, offline divergence (same-field update + colliding display
 * numbers), `kanon sync` on each (pull --rebase + `merge=union` on the
 * segments), then `kanon doctor` — both projections must converge to
 * identical table-dump checksums.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjection, projectionChecksum } from "@kanon/store";

const CLI = join(import.meta.dir, "index.ts");
const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kanon-e2e-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function cliEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("KANON_")) env[key] = value;
  }
  return { ...env, KANON_ACTOR: "carlos@example.com", KANON_ACTOR_TYPE: "human", ...extra };
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function kanon(args: string[], env: Record<string, string> = cliEnv()): CliResult {
  const proc = Bun.spawnSync([process.execPath, CLI, ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: proc.exitCode ?? 1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

/** Run and assert success; returns stdout. */
function ok(args: string[], env?: Record<string, string>): string {
  const result = kanon(args, env);
  if (result.code !== 0) {
    throw new Error(
      `kanon ${args.join(" ")} failed (${result.code}):\n${result.stderr}${result.stdout}`,
    );
  }
  return result.stdout;
}

function git(dir: string, ...args: string[]): string {
  const proc = Bun.spawnSync(["git", ...args], { cwd: dir });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
  }
  return proc.stdout.toString().trim();
}

function gitIdentity(dir: string): void {
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Kanon Test");
}

function checksumOf(dir: string): string {
  const projection = openProjection(dir, { onWarn: () => {} });
  projection.refresh();
  const checksum = projectionChecksum(projection.db);
  projection.close();
  return checksum;
}

describe("full lifecycle (single clone)", () => {
  test("init → team → issues → states → claim → comment → relations → ready → show --json", () => {
    const repo = tempDir();
    ok(["init", repo, "--workspace", "acme", "--no-git"]);
    ok(["team", "create", "--key", "BRO", "--name", "Broomva", "--repo", repo]);

    const teams = JSON.parse(ok(["team", "list", "--repo", repo, "--json"])) as {
      key: string;
    }[];
    expect(teams.map((team) => team.key)).toEqual(["BRO"]);

    // Issues — numbers allocate 1, 2, 3; default state is Backlog.
    const created = ok([
      "issue",
      "create",
      "--team",
      "BRO",
      "--title",
      "First issue",
      "--description",
      "the one",
      "--priority",
      "2",
      "--estimate",
      "3",
      "--label",
      "infra",
      "--label",
      "bug",
      "--repo",
      repo,
    ]);
    expect(created).toContain("BRO-1");
    ok(["issue", "create", "--team", "bro", "--title", "Second issue", "--repo", repo]);
    ok([
      "issue",
      "create",
      "--team",
      "BRO",
      "--title",
      "Third issue",
      "--parent",
      "BRO-1",
      "--repo",
      repo,
    ]);

    // State walk: Todo → In Progress → Done (by name, resolved per team).
    ok(["issue", "update", "BRO-1", "--state", "Todo", "--repo", repo]);
    ok(["issue", "update", "BRO-1", "--state", "In Progress", "--repo", repo]);
    const done = JSON.parse(
      ok(["issue", "update", "BRO-1", "--state", "Done", "--repo", repo, "--json"]),
    ) as { stateId: string };
    expect(done.stateId).toBeTruthy();

    // Claim as an AGENT → delegate seat + started state.
    const agentEnv = cliEnv({ KANON_ACTOR: "smith-agent", KANON_ACTOR_TYPE: "agent" });
    const claimed = JSON.parse(
      ok(["issue", "claim", "BRO-2", "--repo", repo, "--json"], agentEnv),
    ) as { delegateId: string | null; assigneeId: string | null };
    expect(claimed.delegateId).toBeTruthy();
    expect(claimed.assigneeId).toBeNull();

    // Claim as a HUMAN → assignee seat.
    const humanClaim = JSON.parse(ok(["issue", "claim", "BRO-3", "--repo", repo, "--json"])) as {
      assigneeId: string | null;
    };
    expect(humanClaim.assigneeId).toBeTruthy();

    // Put BRO-3 back into a ready state for the blocking checks below.
    ok(["issue", "update", "BRO-3", "--state", "Backlog", "--repo", repo]);

    ok(["issue", "comment", "BRO-1", "--body", "shipped in PR #4", "--repo", repo]);

    // BRO-1 (Done) blocks BRO-3 → completed blocker does NOT block.
    ok(["issue", "relate", "BRO-1", "--blocks", "BRO-3", "--repo", repo]);
    let ready = JSON.parse(ok(["issue", "ready", "--team", "BRO", "--repo", repo, "--json"])) as {
      identifier: string;
    }[];
    expect(ready.map((issue) => issue.identifier)).toContain("BRO-3");

    // BRO-2 (In Progress, open) blocks BRO-3 → excluded from ready.
    ok(["issue", "relate", "BRO-3", "--blocked-by", "BRO-2", "--repo", repo]);
    ready = JSON.parse(ok(["issue", "ready", "--team", "BRO", "--repo", repo, "--json"])) as {
      identifier: string;
    }[];
    expect(ready.map((issue) => issue.identifier)).not.toContain("BRO-3");

    // Unrelate the open blocker → ready again.
    ok(["issue", "unrelate", "BRO-3", "--blocked-by", "BRO-2", "--repo", repo]);
    ready = JSON.parse(ok(["issue", "ready", "--team", "BRO", "--repo", repo, "--json"])) as {
      identifier: string;
    }[];
    expect(ready.map((issue) => issue.identifier)).toContain("BRO-3");

    // show --json round-trips everything written above.
    const shown = JSON.parse(ok(["issue", "show", "BRO-1", "--repo", repo, "--json"])) as {
      issue: {
        id: string;
        identifier: string;
        title: string;
        description: string;
        priority: number;
        estimate: number;
        labelIds: string[];
      };
      state: { name: string; stateType: string };
      comments: { body: string }[];
      relations: { relType: string; relatedIssueIdentifier: string }[];
    };
    expect(shown.issue.identifier).toBe("BRO-1");
    expect(shown.issue.title).toBe("First issue");
    expect(shown.issue.description).toBe("the one");
    expect(shown.issue.priority).toBe(2);
    expect(shown.issue.estimate).toBe(3);
    expect(shown.issue.labelIds.length).toBe(2);
    expect(shown.state.name).toBe("Done");
    expect(shown.state.stateType).toBe("completed");
    expect(shown.comments.map((comment) => comment.body)).toEqual(["shipped in PR #4"]);
    expect(shown.relations.map((relation) => relation.relType)).toEqual(["blocks"]);
    expect(shown.relations[0]?.relatedIssueIdentifier).toBe("BRO-3");

    // show by ULID returns the same issue.
    const byUlid = JSON.parse(ok(["issue", "show", shown.issue.id, "--repo", repo, "--json"])) as {
      issue: { identifier: string };
    };
    expect(byUlid.issue.identifier).toBe("BRO-1");

    // list filters + archive + label round-trip.
    ok(["issue", "archive", "BRO-1", "--repo", repo]);
    const active = JSON.parse(ok(["issue", "list", "--no-archived", "--repo", repo, "--json"])) as {
      identifier: string;
    }[];
    expect(active.map((issue) => issue.identifier)).not.toContain("BRO-1");
    const byLabel = JSON.parse(
      ok(["issue", "list", "--label", "infra", "--repo", repo, "--json"]),
    ) as { identifier: string }[];
    expect(byLabel.map((issue) => issue.identifier)).toEqual(["BRO-1"]);
    ok(["issue", "update", "BRO-2", "--add-label", "infra", "--repo", repo]);
    ok(["issue", "update", "BRO-2", "--remove-label", "infra", "--repo", repo]);

    // projects + milestones.
    ok(["project", "create", "--name", "Kanon", "--description", "tracker", "--repo", repo]);
    ok(["milestone", "create", "--name", "M1", "--project", "Kanon", "--repo", repo]);
    const milestones = JSON.parse(
      ok(["milestone", "list", "--project", "Kanon", "--repo", repo, "--json"]),
    ) as { name: string }[];
    expect(milestones.map((milestone) => milestone.name)).toEqual(["M1"]);
    ok([
      "issue",
      "create",
      "--team",
      "BRO",
      "--title",
      "Milestoned",
      "--project",
      "Kanon",
      "--milestone",
      "M1",
      "--repo",
      repo,
    ]);

    // log + validate stay healthy after the whole run.
    const logged = JSON.parse(ok(["log", "--limit", "5", "--repo", repo, "--json"])) as {
      id: string;
    }[];
    expect(logged.length).toBe(5);
    expect(ok(["validate", repo])).toContain("ok:");

    // doctor: clean single-clone repo has nothing to repair.
    const health = JSON.parse(ok(["doctor", "--repo", repo, "--json"])) as { ok: boolean };
    expect(health.ok).toBe(true);
  }, 60_000);

  test("strict flags: unknown flags and missing values are hard errors", () => {
    const repo = tempDir();
    ok(["init", repo, "--workspace", "acme", "--no-git"]);
    ok(["team", "create", "--key", "BRO", "--name", "Broomva", "--repo", repo]);

    const typo = kanon([
      "issue",
      "create",
      "--team",
      "BRO",
      "--title",
      "x",
      "--dryrun",
      "--repo",
      repo,
    ]);
    expect(typo.code).toBe(1);
    expect(typo.stderr).toContain("unknown flag: --dryrun");

    const missing = kanon(["issue", "list", "--repo", repo, "--limit"]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("--limit requires a value");

    const badPriority = kanon([
      "issue",
      "create",
      "--team",
      "BRO",
      "--title",
      "x",
      "--priority",
      "9",
      "--repo",
      repo,
    ]);
    expect(badPriority.code).toBe(1);
    expect(badPriority.stderr).toContain("--priority must be an integer between 0 and 4");

    const badState = kanon(["issue", "update", "BRO-99", "--state", "Done", "--repo", repo]);
    expect(badState.code).toBe(1);
    expect(badState.stderr).toContain("no issue matching");
  });
});

describe("display numbering", () => {
  test("continues from seeded displayCounters (importer watermark contract)", () => {
    const repo = tempDir();
    ok(["init", repo, "--workspace", "broomva", "--no-git"]);

    // Simulate the Linear importer seeding BRO → 1651.
    const metaPath = join(repo, "meta.json");
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;
    meta.displayCounters = { BRO: 1651 };
    writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);

    ok(["team", "create", "--key", "BRO", "--name", "Broomva", "--repo", repo]);
    const created = ok(["issue", "create", "--team", "BRO", "--title", "Next", "--repo", repo]);
    expect(created).toContain("BRO-1652");

    // Watermark persisted back.
    const after = JSON.parse(readFileSync(metaPath, "utf8")) as {
      displayCounters: Record<string, number>;
    };
    expect(after.displayCounters.BRO).toBe(1652);
  });
});

describe("two-clone convergence", () => {
  test("offline divergence + sync (rebase, union merge) + doctor → identical projections", () => {
    const root = tempDir();
    const origin = join(root, "origin.git");
    const cloneA = join(root, "a");
    const cloneB = join(root, "b");
    git(root, "init", "--bare", "origin.git");

    // Clone A: init the workspace, seed team + shared issue, push.
    git(root, "clone", origin, "a");
    ok(["init", cloneA, "--workspace", "acme"]);
    gitIdentity(cloneA);
    ok(["team", "create", "--key", "BRO", "--name", "Broomva", "--repo", cloneA]);
    ok(["issue", "create", "--team", "BRO", "--title", "Shared issue", "--repo", cloneA]);
    ok(["sync", "--repo", cloneA]);

    // Clone B: full replica via git.
    git(root, "clone", origin, "b");
    gitIdentity(cloneB);
    expect(ok(["validate", cloneB])).toContain("ok:");

    // Offline divergence: both update the SAME field of the SAME issue,
    // and both allocate the SAME display number for new issues.
    ok(["issue", "update", "BRO-1", "--title", "Title from A", "--repo", cloneA]);
    ok(["issue", "update", "BRO-1", "--title", "Title from B", "--repo", cloneB]);
    ok(["issue", "create", "--team", "BRO", "--title", "From A", "--repo", cloneA]);
    ok(["issue", "create", "--team", "BRO", "--title", "From B", "--repo", cloneB]);

    // Sync dance: A pushes, B rebases (union-merged segments) and pushes,
    // A pulls B's history.
    ok(["sync", "--repo", cloneA]);
    ok(["sync", "--repo", cloneB]);
    ok(["sync", "--repo", cloneA]);

    // Same log ⇒ same projection, byte for byte.
    expect(checksumOf(cloneA)).toBe(checksumOf(cloneB));

    // The same-field update converged via LWW to ONE title on both.
    const titleA = (
      JSON.parse(ok(["issue", "show", "BRO-1", "--repo", cloneA, "--json"])) as {
        issue: { title: string };
      }
    ).issue.title;
    const titleB = (
      JSON.parse(ok(["issue", "show", "BRO-1", "--repo", cloneB, "--json"])) as {
        issue: { title: string };
      }
    ).issue.title;
    expect(titleA).toBe(titleB);
    expect(["Title from A", "Title from B"]).toContain(titleA);

    // Both clones now carry TWO issues numbered 2 — a duplicate identifier.
    const dupes = JSON.parse(ok(["issue", "list", "--repo", cloneA, "--json"])) as {
      identifier: string | null;
    }[];
    expect(dupes.filter((issue) => issue.identifier === "BRO-2").length).toBe(2);

    // Doctor on A repairs: the LATER-ULID issue gets the next free number.
    const repair = JSON.parse(ok(["doctor", "--repo", cloneA, "--json"])) as {
      ok: boolean;
      duplicates: { identifier: string; newIdentifier: string }[];
    };
    expect(repair.ok).toBe(false);
    expect(repair.duplicates.length).toBe(1);
    expect(repair.duplicates[0]?.identifier).toBe("BRO-2");
    expect(repair.duplicates[0]?.newIdentifier).toBe("BRO-3");

    // Replicate the repair; both clones converge again.
    ok(["sync", "--repo", cloneA]);
    ok(["sync", "--repo", cloneB]);
    expect(checksumOf(cloneA)).toBe(checksumOf(cloneB));

    for (const clone of [cloneA, cloneB]) {
      const issues = JSON.parse(ok(["issue", "list", "--repo", clone, "--json"])) as {
        identifier: string | null;
      }[];
      const identifiers = issues.map((issue) => issue.identifier).sort();
      expect(identifiers).toEqual(["BRO-1", "BRO-2", "BRO-3"]);
      const health = JSON.parse(ok(["doctor", "--repo", clone, "--json"])) as { ok: boolean };
      expect(health.ok).toBe(true);
      expect(ok(["validate", clone])).toContain("ok:");
    }
  }, 120_000);
});
