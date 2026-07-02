/**
 * `kanon sync` — explicit replication, no hidden daemon:
 *
 *   git add events/ meta.json snapshots/ (+ .gitattributes/.gitignore)
 *   → commit (skipped when clean) → pull --rebase → push
 *
 * Every step is surfaced. Segment files merge cleanly because `kanon init`
 * writes `.gitattributes` with `events/*.jsonl merge=union` — concurrent
 * appends union instead of conflicting, and the ULID sort on load restores
 * the canonical order. A meta.json conflict aborts the rebase and instructs
 * the user; after any successful pull, `kanon doctor` repairs duplicate
 * identifiers and stale watermarks.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveActor } from "../actor";
import { CliError, flagBool, parseFlags } from "../args";
import { openRepo } from "../context";

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

function git(dir: string, args: string[]): GitResult {
  const proc = Bun.spawnSync(["git", ...args], { cwd: dir });
  return {
    code: proc.exitCode ?? 1,
    stdout: proc.stdout.toString().trim(),
    stderr: proc.stderr.toString().trim(),
  };
}

interface SyncStep {
  step: "add" | "commit" | "pull" | "push";
  status: "ok" | "skipped" | "failed";
  detail: string;
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

  // -- add + commit -----------------------------------------------------------
  const paths = ["events", "meta.json", "snapshots", ".gitattributes", ".gitignore"].filter(
    (path) => existsSync(join(dir, path)),
  );
  const add = git(dir, ["add", "-A", "--", ...paths]);
  if (add.code !== 0) {
    report({ step: "add", status: "failed", detail: add.stderr });
    finish(false);
    return;
  }
  report({ step: "add", status: "ok", detail: paths.join(" ") });

  const staged = git(dir, ["diff", "--cached", "--quiet"]);
  if (staged.code === 0) {
    report({ step: "commit", status: "skipped", detail: "nothing to commit" });
  } else {
    const commit = git(dir, ["commit", "-m", `kanon sync ${new Date().toISOString()}`]);
    if (commit.code !== 0) {
      report({ step: "commit", status: "failed", detail: commit.stderr || commit.stdout });
      finish(false);
      return;
    }
    report({
      step: "commit",
      status: "ok",
      detail: git(dir, ["rev-parse", "--short", "HEAD"]).stdout,
    });
  }

  // -- pull --rebase ----------------------------------------------------------
  const upstream = git(dir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (upstream.code !== 0) {
    report({ step: "pull", status: "skipped", detail: "no upstream configured" });
  } else {
    const pull = git(dir, ["pull", "--rebase"]);
    if (pull.code !== 0) {
      const conflicted = git(dir, ["diff", "--name-only", "--diff-filter=U"])
        .stdout.split("\n")
        .filter((line) => line.length > 0);
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
    report({ step: "pull", status: "ok", detail: pull.stdout.split("\n")[0] ?? "up to date" });
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
