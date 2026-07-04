/**
 * `kanon sync` — explicit replication, no hidden daemon:
 *
 *   git add events/ meta.json snapshots/ (+ .gitattributes/.gitignore)
 *   → commit (skipped when clean) → pull --rebase → doctor → push
 *
 * Every step is surfaced. Segment files merge cleanly because `kanon init`
 * writes `.gitattributes` with `events/*.jsonl merge=union` — concurrent
 * appends union instead of conflicting, and the ULID sort on load restores
 * the canonical order.
 *
 * meta.json is the ONE file that can genuinely conflict on rebase: two clones
 * that allocated a different COUNT of issues offline diverge on
 * `displayCounters`. That is the common case, not the edge — and its
 * resolution is purely mechanical (max per team key, because watermarks are
 * monotonic). So when the rebase conflicts on meta.json ALONE, sync resolves
 * it automatically: parse both sides, take the max per key, write the merged
 * meta with `writeDataRepoMeta` (identical byte formatting), and continue the
 * rebase. Any OTHER conflicted file — or a meta.json whose `workspace` /
 * `schemaVersion` differ between the two sides (a real conflict, not a counter
 * race) — falls back to the safe path: abort the rebase and print the manual
 * hint.
 *
 * After any successful pull, `kanon doctor`'s repair runs in-process: it
 * reassigns duplicate identifiers minted by concurrent offline clones and
 * raises stale watermarks. Reassignments are surfaced in the sync output —
 * agents that cache `TEAM-N` identifiers across syncs would otherwise misfire
 * silently when doctor renumbers them.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { type DataRepoMeta, writeDataRepoMeta } from "@kanon/store";
import { resolveActor } from "../actor";
import { CliError, flagBool, parseFlags } from "../args";
import { openRepo } from "../context";
import { runDoctorRepair } from "./doctor";

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

function git(dir: string, args: string[], env?: Record<string, string>): GitResult {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd: dir,
    env: env ? { ...process.env, ...env } : process.env,
  });
  return {
    code: proc.exitCode ?? 1,
    stdout: proc.stdout.toString().trim(),
    stderr: proc.stderr.toString().trim(),
  };
}

interface SyncStep {
  step: "add" | "commit" | "pull" | "doctor" | "push";
  status: "ok" | "skipped" | "failed";
  detail: string;
}

/** Files currently conflicted (unmerged) in the working tree. */
function conflictedFiles(dir: string): string[] {
  return git(dir, ["diff", "--name-only", "--diff-filter=U"])
    .stdout.split("\n")
    .filter((line) => line.length > 0);
}

/**
 * Merge two `DataRepoMeta` sides of a meta.json rebase conflict. The ONLY
 * field allowed to differ is `displayCounters` (per-key max — watermarks are
 * monotonic, so direction doesn't matter and ours/theirs being swapped under
 * rebase is irrelevant). `createdAt` may differ between clones (each ran its
 * own `init`); it is not a merge signal, so we keep `ours`. If `workspace` or
 * `schemaVersion` differ, this is a REAL conflict — return null so the caller
 * falls back to abort+hint.
 */
function mergeMetaConflict(ours: DataRepoMeta, theirs: DataRepoMeta): DataRepoMeta | null {
  if (ours.workspace !== theirs.workspace || ours.schemaVersion !== theirs.schemaVersion) {
    return null;
  }
  const merged: Record<string, number> = { ...(ours.displayCounters ?? {}) };
  for (const [key, value] of Object.entries(theirs.displayCounters ?? {})) {
    merged[key] = Math.max(merged[key] ?? 0, value);
  }
  return { ...ours, displayCounters: merged };
}

/** Read one stage of the meta.json conflict (`:2:` ours, `:3:` theirs). */
function readMetaStage(dir: string, stage: 2 | 3): DataRepoMeta {
  const show = git(dir, ["show", `:${stage}:meta.json`]);
  if (show.code !== 0) {
    throw new Error(`could not read stage ${stage} of meta.json: ${show.stderr || "unknown"}`);
  }
  return JSON.parse(show.stdout) as DataRepoMeta;
}

/**
 * A conflicting rebase whose ONLY unmerged file is meta.json is a
 * displayCounters race. Resolve every step of the replay by max-per-key and
 * `rebase --continue`. Returns true on full success; false means "not
 * auto-resolvable — caller should abort and hint". Bounded (later replayed
 * commits can each re-conflict on meta.json) so a pathological history can
 * never spin forever.
 */
function autoResolveMetaRebase(dir: string): boolean {
  const MAX_STEPS = 50;
  for (let step = 0; step < MAX_STEPS; step++) {
    const conflicted = conflictedFiles(dir);
    if (conflicted.length === 0) return false; // nothing unmerged but rebase not done — unknown state
    if (conflicted.length !== 1 || conflicted[0] !== "meta.json") return false;

    let merged: DataRepoMeta | null;
    try {
      merged = mergeMetaConflict(readMetaStage(dir, 2), readMetaStage(dir, 3));
    } catch {
      return false; // couldn't parse a side — treat as a real conflict
    }
    if (merged === null) return false; // workspace/schema differ — real conflict

    writeDataRepoMeta(dir, merged);
    if (git(dir, ["add", "meta.json"]).code !== 0) return false;
    // GIT_EDITOR=true: `rebase --continue` must never open an editor.
    const cont = git(dir, ["rebase", "--continue"], { GIT_EDITOR: "true" });

    // Rebase finished cleanly?
    if (git(dir, ["rev-parse", "--git-dir"]).code === 0) {
      const gitDir = git(dir, ["rev-parse", "--git-dir"]).stdout;
      const rebasing =
        existsSync(join(dir, gitDir, "rebase-merge")) ||
        existsSync(join(dir, gitDir, "rebase-apply"));
      if (!rebasing) return cont.code === 0;
    }
    // Still rebasing — loop to resolve the next conflicting commit.
  }
  return false; // exceeded the step cap — bail to the abort path
}

export function sync(argv: string[]): void {
  const { flags } = parseFlags(
    argv,
    { json: "boolean", repo: "value" },
    { min: 0, max: 0, usage: "kanon sync" },
  );
  const json = flagBool(flags, "json");
  const ctx = openRepo(flags, resolveActor());
  const dir = ctx.dir;
  const steps: SyncStep[] = [];
  const report = (step: SyncStep): void => {
    steps.push(step);
    if (!json) {
      const mark = step.status === "ok" ? "✔" : step.status === "skipped" ? "•" : "✖";
      console.log(`${mark} ${step.step}: ${step.detail}`);
    }
  };
  const finish = (ok: boolean): never => {
    ctx.projection.refresh();
    ctx.projection.close();
    if (json) {
      console.log(JSON.stringify({ ok, steps }, null, 2));
    }
    process.exit(ok ? 0 : 1);
  };

  if (git(dir, ["rev-parse", "--git-dir"]).code !== 0) {
    throw new CliError(`${dir} is not a git repository — re-run kanon init, or git init it`);
  }

  // stage the canonical log files (whichever exist) + commit when dirty.
  // Returns false only on a hard git failure (already reported).
  const stagePaths = (): string[] =>
    ["events", "meta.json", "snapshots", ".gitattributes", ".gitignore"].filter((path) =>
      existsSync(join(dir, path)),
    );
  const addAndCommit = (): boolean => {
    const paths = stagePaths();
    const add = git(dir, ["add", "-A", "--", ...paths]);
    if (add.code !== 0) {
      report({ step: "add", status: "failed", detail: add.stderr });
      return false;
    }
    report({ step: "add", status: "ok", detail: paths.join(" ") });

    if (git(dir, ["diff", "--cached", "--quiet"]).code === 0) {
      report({ step: "commit", status: "skipped", detail: "nothing to commit" });
      return true;
    }
    const commit = git(dir, ["commit", "-m", `kanon sync ${new Date().toISOString()}`]);
    if (commit.code !== 0) {
      report({ step: "commit", status: "failed", detail: commit.stderr || commit.stdout });
      return false;
    }
    report({
      step: "commit",
      status: "ok",
      detail: git(dir, ["rev-parse", "--short", "HEAD"]).stdout,
    });
    return true;
  };

  // -- add + commit -----------------------------------------------------------
  if (!addAndCommit()) {
    finish(false);
    return;
  }

  // -- pull --rebase ----------------------------------------------------------
  const upstream = git(dir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (upstream.code !== 0) {
    report({ step: "pull", status: "skipped", detail: "no upstream configured" });
  } else {
    const pull = git(dir, ["pull", "--rebase"]);
    if (pull.code !== 0) {
      const conflicted = conflictedFiles(dir);
      // The common case: only meta.json conflicts (two clones allocated a
      // different COUNT of issues offline → displayCounters diverge). Resolve
      // mechanically — max per team key — and continue the rebase.
      if (conflicted.length === 1 && conflicted[0] === "meta.json" && autoResolveMetaRebase(dir)) {
        report({
          step: "pull",
          status: "ok",
          detail: "auto-resolved meta.json displayCounters (max per key)",
        });
      } else {
        // Not auto-resolvable (other files conflicted, or a real
        // workspace/schema divergence): keep the safe path — abort + hint.
        // autoResolveMetaRebase leaves the rebase in progress on failure.
        git(dir, ["rebase", "--abort"]);
        const hint = conflicted.includes("meta.json")
          ? " meta.json conflicted: resolve by keeping the HIGHER counter per team key (watermarks " +
            "are monotonic), commit, then run `kanon doctor` to verify watermarks and repair any " +
            "duplicate identifiers."
          : "";
        report({
          step: "pull",
          status: "failed",
          detail:
            "pull --rebase failed (rebase aborted, repo left clean). Conflicts: " +
            `${conflicted.join(", ") || pull.stderr || "unknown"}.${hint}`,
        });
        finish(false);
        return;
      }
    } else {
      report({ step: "pull", status: "ok", detail: pull.stdout.split("\n")[0] ?? "up to date" });
    }

    // -- doctor (post-merge repair) -------------------------------------------
    // A pull can import issues this clone never allocated: concurrent offline
    // clones can mint the SAME identifier, and watermarks can fall behind the
    // synced-in projection max. Repair both, and SURFACE any identifier
    // reassignments — agents caching `TEAM-N` across syncs must learn they
    // were renumbered, or they misfire silently on the stale identifier.
    ctx.projection.refresh(); // see the just-pulled events
    const repair = runDoctorRepair(ctx);
    if (repair.duplicates.length === 0 && repair.watermarks.length === 0) {
      report({ step: "doctor", status: "skipped", detail: "no repairs" });
    } else {
      const parts: string[] = [];
      if (repair.duplicates.length > 0) {
        parts.push(
          `reassigned ${repair.duplicates
            .map((fix) => `${fix.identifier}→${fix.newIdentifier}`)
            .join(", ")}`,
        );
      }
      if (repair.watermarks.length > 0) {
        parts.push(
          `raised watermark ${repair.watermarks
            .map((fix) => `${fix.team} ${fix.from}→${fix.to}`)
            .join(", ")}`,
        );
      }
      report({ step: "doctor", status: "ok", detail: parts.join("; ") });
      // Doctor wrote repair events (reassignments + watermark) to the log.
      // Commit them so THIS sync replicates them — no second `kanon sync`
      // needed just to push the repair.
      if (!addAndCommit()) {
        finish(false);
        return;
      }
    }
  }

  // -- push --------------------------------------------------------------------
  if (upstream.code === 0) {
    const push = git(dir, ["push"]);
    if (push.code !== 0) {
      report({ step: "push", status: "failed", detail: push.stderr });
      finish(false);
      return;
    }
    report({ step: "push", status: "ok", detail: "pushed" });
  } else if (git(dir, ["remote", "get-url", "origin"]).code === 0) {
    const push = git(dir, ["push", "-u", "origin", "HEAD"]);
    if (push.code !== 0) {
      report({ step: "push", status: "failed", detail: push.stderr });
      finish(false);
      return;
    }
    report({ step: "push", status: "ok", detail: "pushed (set upstream origin)" });
  } else {
    report({ step: "push", status: "skipped", detail: "no remote configured" });
  }

  finish(true);
}
