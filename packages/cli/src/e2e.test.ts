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

/** Async variant for true parallel invocations. */
async function kanonAsync(
  args: string[],
  env: Record<string, string> = cliEnv(),
): Promise<CliResult> {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
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

    // `--flag=` and `--flag ""` behave identically: both hard errors.
    const emptyInline = kanon(["issue", "create", "--team", "BRO", "--title=", "--repo", repo]);
    expect(emptyInline.code).toBe(1);
    expect(emptyInline.stderr).toContain("--title requires a value");
    const emptySeparate = kanon([
      "issue",
      "create",
      "--team",
      "BRO",
      "--title",
      "",
      "--repo",
      repo,
    ]);
    expect(emptySeparate.code).toBe(1);
    expect(emptySeparate.stderr).toContain("--title requires a value");
  });

  test("team keys are validated against the identifier charset at create", () => {
    const repo = tempDir();
    ok(["init", repo, "--workspace", "acme", "--no-git"]);

    for (const badKey of ["BAD KEY", "9BRO", "BRO-1", "bro_x"]) {
      const result = kanon(["team", "create", "--key", badKey, "--name", "X", "--repo", repo]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("--key must be a letter followed by letters/digits");
    }
    ok(["team", "create", "--key", "Bro2", "--name", "OK", "--repo", repo]);
  });

  test("repeated --label refs mint ONE label (no permanent ambiguity)", () => {
    const repo = tempDir();
    ok(["init", repo, "--workspace", "acme", "--no-git"]);
    ok(["team", "create", "--key", "BRO", "--name", "Broomva", "--repo", repo]);

    // Same new label referenced three times (case-varied) in ONE create.
    ok([
      "issue",
      "create",
      "--team",
      "BRO",
      "--title",
      "L1",
      "--label",
      "bug",
      "--label",
      "Bug",
      "--label",
      "bug",
      "--repo",
      repo,
    ]);
    const first = JSON.parse(ok(["issue", "show", "BRO-1", "--repo", repo, "--json"])) as {
      issue: { labelIds: string[] };
    };
    expect(first.issue.labelIds.length).toBe(1);

    // The label resolves (not ambiguous) for the NEXT command, same entity.
    ok(["issue", "create", "--team", "BRO", "--title", "L2", "--label", "BUG", "--repo", repo]);
    const second = JSON.parse(ok(["issue", "show", "BRO-2", "--repo", repo, "--json"])) as {
      issue: { labelIds: string[] };
    };
    expect(second.issue.labelIds).toEqual(first.issue.labelIds);

    // --add-label dedupes pending mints the same way.
    ok(["issue", "update", "BRO-2", "--add-label", "new1", "--add-label", "New1", "--repo", repo]);
    const updated = JSON.parse(ok(["issue", "show", "BRO-2", "--repo", repo, "--json"])) as {
      issue: { labelIds: string[] };
    };
    expect(updated.issue.labelIds.length).toBe(2);
  });

  test("a failed create burns no display number", () => {
    const repo = tempDir();
    ok(["init", repo, "--workspace", "acme", "--no-git"]);
    ok(["team", "create", "--key", "BRO", "--name", "Broomva", "--repo", repo]);
    ok(["issue", "create", "--team", "BRO", "--title", "First", "--repo", repo]);

    // Reference resolution fails AFTER flags parse — must not touch meta.
    const bad = kanon([
      "issue",
      "create",
      "--team",
      "BRO",
      "--title",
      "x",
      "--assignee",
      "nobody",
      "--repo",
      repo,
    ]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("no actor matching");
    const meta = JSON.parse(readFileSync(join(repo, "meta.json"), "utf8")) as {
      displayCounters: Record<string, number>;
    };
    expect(meta.displayCounters.BRO).toBe(1); // watermark untouched

    // The next successful create is contiguous: BRO-2, not BRO-3.
    expect(ok(["issue", "create", "--team", "BRO", "--title", "Second", "--repo", repo])).toContain(
      "BRO-2",
    );
  });
});

describe("same-clone concurrency", () => {
  test("8 parallel creates: unique numbers or clean retryable errors, never double-create", async () => {
    const repo = tempDir();
    ok(["init", repo, "--workspace", "acme", "--no-git"]);
    ok(["team", "create", "--key", "BRO", "--name", "Broomva", "--repo", repo]);

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        kanonAsync([
          "issue",
          "create",
          "--team",
          "BRO",
          "--title",
          `conc-${i}`,
          "--repo",
          repo,
          "--json",
        ]),
      ),
    );
    const succeeded = results.filter((result) => result.code === 0);
    const failed = results.filter((result) => result.code !== 0);

    // Failures (if any) must be clean retryable errors — no raw stack traces.
    for (const failure of failed) {
      expect(failure.stderr).toContain("error:");
      expect(failure.stderr).not.toMatch(/\n\s+at /);
    }

    // Every success allocated a UNIQUE number, and the log agrees exactly:
    // one issue per success — a retrying agent never double-creates.
    const numbers = succeeded.map(
      (result) => (JSON.parse(result.stdout) as { number: number }).number,
    );
    expect(new Set(numbers).size).toBe(numbers.length);
    const issues = JSON.parse(ok(["issue", "list", "--repo", repo, "--json"])) as {
      identifier: string;
    }[];
    expect(issues.length).toBe(succeeded.length);
    expect(new Set(issues.map((issue) => issue.identifier)).size).toBe(issues.length);

    const health = JSON.parse(ok(["doctor", "--repo", repo, "--json"])) as { ok: boolean };
    expect(health.ok).toBe(true);
    expect(ok(["validate", repo])).toContain("ok:");

    // With locked allocation + busy_timeout, all eight succeed outright.
    expect(succeeded.length).toBe(8);
  }, 60_000);
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
  test("offline divergence + sync (rebase, union merge, in-sync doctor) → identical, healed projections", () => {
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
    // and both allocate the SAME display number for new issues (both BRO-2).
    ok(["issue", "update", "BRO-1", "--title", "Title from A", "--repo", cloneA]);
    ok(["issue", "update", "BRO-1", "--title", "Title from B", "--repo", cloneB]);
    ok(["issue", "create", "--team", "BRO", "--title", "From A", "--repo", cloneA]);
    ok(["issue", "create", "--team", "BRO", "--title", "From B", "--repo", cloneB]);

    // Sync dance: A pushes, B rebases (union-merged segments) — and B's sync
    // now runs doctor in-process, healing the duplicate BRO-2 to BRO-3 and
    // pushing the repair. A then pulls B's history (repair included). No
    // manual `kanon doctor` step is needed any more: sync self-heals.
    ok(["sync", "--repo", cloneA]);
    ok(["sync", "--repo", cloneB]);
    ok(["sync", "--repo", cloneA]);
    // One more round-trip settles any second-order repair across both clones.
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

    // The duplicate BRO-2 was healed by sync's in-process doctor — no manual
    // repair. Both clones already carry the deduped, renumbered set.
    for (const clone of [cloneA, cloneB]) {
      const issues = JSON.parse(ok(["issue", "list", "--repo", clone, "--json"])) as {
        identifier: string | null;
      }[];
      const identifiers = issues.map((issue) => issue.identifier).sort();
      expect(identifiers).toEqual(["BRO-1", "BRO-2", "BRO-3"]);
      // Post-sync doctor is a no-op: sync already repaired everything.
      const health = JSON.parse(ok(["doctor", "--repo", clone, "--json"])) as { ok: boolean };
      expect(health.ok).toBe(true);
      expect(ok(["validate", clone])).toContain("ok:");
    }
  }, 120_000);
});

describe("sync auto-resolves meta.json displayCounters conflicts (BRO-1653)", () => {
  interface SyncStep {
    step: string;
    status: string;
    detail: string;
  }
  interface SyncResult {
    ok: boolean;
    steps: SyncStep[];
  }
  const stepOf = (result: SyncResult, step: string): SyncStep | undefined =>
    result.steps.find((s) => s.step === step);

  test("divergent offline counts → auto-resolve (max per key) + doctor renumber, no manual intervention", () => {
    const root = tempDir();
    const origin = join(root, "origin.git");
    const cloneA = join(root, "a");
    const cloneB = join(root, "b");
    git(root, "init", "--bare", "origin.git");

    // Clone A seeds the workspace + team + one shared issue, pushes.
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

    // Offline divergence with DIFFERENT counts: A allocates one new issue
    // (BRO → 2), B allocates two (BRO → 3). displayCounters now differ
    // between clones — this is the meta.json conflict BRO-1653 targets.
    ok(["issue", "create", "--team", "BRO", "--title", "From A", "--repo", cloneA]);
    ok(["issue", "create", "--team", "BRO", "--title", "From B1", "--repo", cloneB]);
    ok(["issue", "create", "--team", "BRO", "--title", "From B2", "--repo", cloneB]);

    const metaCount = (dir: string): number =>
      (
        JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as {
          displayCounters: Record<string, number>;
        }
      ).displayCounters.BRO ?? 0;
    expect(metaCount(cloneA)).toBe(2);
    expect(metaCount(cloneB)).toBe(3);

    // A pushes first. B's sync must rebase over A's meta.json and hit the
    // displayCounters conflict — and resolve it WITHOUT any manual step.
    ok(["sync", "--repo", cloneA]);
    const syncB = JSON.parse(ok(["sync", "--repo", cloneB, "--json"])) as SyncResult;
    expect(syncB.ok).toBe(true);

    // (a) sync succeeded with the auto-resolve pull step + a doctor step.
    const pullB = stepOf(syncB, "pull");
    expect(pullB?.status).toBe("ok");
    expect(pullB?.detail).toContain("auto-resolved meta.json displayCounters");
    const doctorB = stepOf(syncB, "doctor");
    expect(doctorB).toBeDefined();
    // B pulled in A's BRO-2 while holding its own BRO-2 → duplicate; doctor
    // renumbers the later one and SURFACES the reassignment in sync output.
    expect(doctorB?.status).toBe("ok");
    expect(doctorB?.detail).toContain("reassigned");
    expect(doctorB?.detail).toContain("BRO-2");

    // A pulls B's history (incl. B's repair). Second-order: A now also sees
    // the duplicate BRO-2, so A's own sync doctor may renumber on A's side —
    // still no manual intervention.
    const syncA = JSON.parse(ok(["sync", "--repo", cloneA, "--json"])) as SyncResult;
    expect(syncA.ok).toBe(true);
    // Converge: one more round-trip settles any residual repair.
    ok(["sync", "--repo", cloneB]);
    ok(["sync", "--repo", cloneA]);
    ok(["sync", "--repo", cloneB]);

    // (b) final meta.json displayCounters == max of the two diverged sides,
    // raised by any doctor renumber above it. It must be >= 3 (the higher
    // pre-merge count) and identical on both clones.
    const finalA = metaCount(cloneA);
    const finalB = metaCount(cloneB);
    expect(finalA).toBe(finalB);
    expect(finalA).toBeGreaterThanOrEqual(3);

    // (c) both projections converge byte-for-byte.
    expect(checksumOf(cloneA)).toBe(checksumOf(cloneB));

    // (d) no duplicate identifiers, and each clone is healthy.
    for (const clone of [cloneA, cloneB]) {
      const issues = JSON.parse(ok(["issue", "list", "--repo", clone, "--json"])) as {
        identifier: string | null;
      }[];
      const identifiers = issues.map((issue) => issue.identifier);
      expect(new Set(identifiers).size).toBe(identifiers.length); // all unique
      const health = JSON.parse(ok(["doctor", "--repo", clone, "--json"])) as { ok: boolean };
      expect(health.ok).toBe(true);
      expect(ok(["validate", clone])).toContain("ok:");
    }
  }, 120_000);

  test("a genuine non-counter meta.json divergence still falls back to abort + manual hint", () => {
    const root = tempDir();
    const origin = join(root, "origin.git");
    const cloneA = join(root, "a");
    const cloneB = join(root, "b");
    git(root, "init", "--bare", "origin.git");

    git(root, "clone", origin, "a");
    ok(["init", cloneA, "--workspace", "acme"]);
    gitIdentity(cloneA);
    ok(["team", "create", "--key", "BRO", "--name", "Broomva", "--repo", cloneA]);
    ok(["issue", "create", "--team", "BRO", "--title", "Shared", "--repo", cloneA]);
    ok(["sync", "--repo", cloneA]);

    git(root, "clone", origin, "b");
    gitIdentity(cloneB);

    // Corrupt the `workspace` field on B's side ONLY (a real conflict, not a
    // counter race). Both clones commit a meta.json change so the rebase
    // conflicts on meta.json with differing non-counter fields.
    ok(["issue", "create", "--team", "BRO", "--title", "From A", "--repo", cloneA]);
    ok(["sync", "--repo", cloneA]);

    const metaPathB = join(cloneB, "meta.json");
    const metaB = JSON.parse(readFileSync(metaPathB, "utf8")) as Record<string, unknown>;
    metaB.workspace = "tampered"; // divergent workspace slug
    metaB.displayCounters = { BRO: 5 };
    writeFileSync(metaPathB, `${JSON.stringify(metaB, null, 2)}\n`);
    git(cloneB, "add", "meta.json");
    git(cloneB, "commit", "-m", "tamper workspace");

    // B's sync rebases over A and conflicts on meta.json — but the sides
    // differ on `workspace`, so auto-resolve must REFUSE and fall back to the
    // safe abort+hint path.
    const syncB = kanon(["sync", "--repo", cloneB, "--json"]);
    expect(syncB.code).toBe(1);
    const result = JSON.parse(syncB.stdout) as SyncResult;
    expect(result.ok).toBe(false);
    const pullB = result.steps.find((s) => s.step === "pull");
    expect(pullB?.status).toBe("failed");
    expect(pullB?.detail).toContain("rebase aborted");
    expect(pullB?.detail).toContain("meta.json");

    // Repo left clean (rebase aborted) — no lingering rebase state.
    expect(() => git(cloneB, "rev-parse", "HEAD")).not.toThrow();
    const status = git(cloneB, "status", "--porcelain");
    expect(status).not.toContain("UU meta.json");
  }, 120_000);
});

describe("doctor — relation edges", () => {
  test("flags a blocks cycle (A blocks B blocks A) without repairing it", () => {
    const repo = tempDir();
    ok(["init", repo, "--workspace", "acme", "--no-git"]);
    ok(["team", "create", "--key", "BRO", "--name", "Broomva", "--repo", repo]);
    ok(["issue", "create", "--team", "BRO", "--title", "A", "--repo", repo]);
    ok(["issue", "create", "--team", "BRO", "--title", "B", "--repo", repo]);
    ok(["issue", "relate", "BRO-1", "--blocks", "BRO-2", "--repo", repo]);
    ok(["issue", "relate", "BRO-2", "--blocks", "BRO-1", "--repo", repo]);

    const report = JSON.parse(ok(["doctor", "--repo", repo, "--json"])) as {
      ok: boolean;
      cycles: { issues: string[] }[];
      relationDuplicates: unknown[];
    };
    expect(report.ok).toBe(false);
    expect(report.cycles.length).toBe(1);
    expect([...(report.cycles[0]?.issues ?? [])].sort()).toEqual(["BRO-1", "BRO-2"]);
    // The cycle is flagged, not auto-removed — the edges still exist afterward.
    expect(report.relationDuplicates.length).toBe(0);
  });
});
