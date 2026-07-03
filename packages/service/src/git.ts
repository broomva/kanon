/**
 * Git operations on the server-owned data-repo clone.
 *
 * Every helper is non-throwing: the event log append is the durability
 * point (appendFileSync — the write is in the canonical log before git is
 * ever invoked), so a git failure is an operational warning to surface, not
 * a request failure. Commits are authored as `kanon-server` — attribution
 * lives in the events themselves ({actorType, actorId, sessionId, surface}),
 * never in git commit metadata.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

export interface GitResult {
  ok: boolean;
  detail: string;
}

const IDENTITY = ["-c", "user.name=kanon-server", "-c", "user.email=kanon-server@localhost"];

function git(dir: string, args: string[]): { code: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["git", ...IDENTITY, ...args], { cwd: dir });
  return {
    code: proc.exitCode ?? 1,
    stdout: proc.stdout.toString().trim(),
    stderr: proc.stderr.toString().trim(),
  };
}

export function isGitRepo(dir: string): boolean {
  return git(dir, ["rev-parse", "--git-dir"]).code === 0;
}

/** The log paths a server write can touch (mirrors `kanon sync`). */
const LOG_PATHS = ["events", "meta.json", "snapshots", ".gitattributes", ".gitignore"];

/** `git add <log paths>` + commit when anything is staged. */
export function commitLog(dir: string, message: string): GitResult {
  const paths = LOG_PATHS.filter((path) => existsSync(join(dir, path)));
  const add = git(dir, ["add", "-A", "--", ...paths]);
  if (add.code !== 0) {
    return { ok: false, detail: `git add failed: ${add.stderr}` };
  }
  if (git(dir, ["diff", "--cached", "--quiet"]).code === 0) {
    return { ok: true, detail: "nothing to commit" };
  }
  const commit = git(dir, ["commit", "--quiet", "-m", message]);
  if (commit.code !== 0) {
    return { ok: false, detail: `git commit failed: ${commit.stderr || commit.stdout}` };
  }
  return { ok: true, detail: git(dir, ["rev-parse", "--short", "HEAD"]).stdout };
}

function hasUpstream(dir: string): boolean {
  return git(dir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).code === 0;
}

/** Push to the upstream (or `push -u origin HEAD` when origin exists without one). */
export function pushLog(dir: string): GitResult {
  if (hasUpstream(dir)) {
    const push = git(dir, ["push", "--quiet"]);
    return push.code === 0
      ? { ok: true, detail: "pushed" }
      : { ok: false, detail: `git push failed: ${push.stderr}` };
  }
  if (git(dir, ["remote", "get-url", "origin"]).code === 0) {
    const push = git(dir, ["push", "--quiet", "-u", "origin", "HEAD"]);
    return push.code === 0
      ? { ok: true, detail: "pushed (set upstream origin)" }
      : { ok: false, detail: `git push failed: ${push.stderr}` };
  }
  return { ok: true, detail: "no remote configured — push skipped" };
}

/**
 * `git pull --rebase`. Segment files union-merge (`events/*.jsonl
 * merge=union` from `kanon init`); a real conflict (meta.json) aborts the
 * rebase and leaves the clone clean — the caller surfaces the warning and
 * the periodic loop retries.
 */
export function pullRebaseLog(dir: string): GitResult {
  if (!hasUpstream(dir)) {
    return { ok: true, detail: "no upstream configured — pull skipped" };
  }
  const pull = git(dir, ["pull", "--rebase", "--quiet"]);
  if (pull.code !== 0) {
    const conflicted = git(dir, ["diff", "--name-only", "--diff-filter=U"])
      .stdout.split("\n")
      .filter((line) => line.length > 0);
    git(dir, ["rebase", "--abort"]);
    return {
      ok: false,
      detail:
        "pull --rebase failed (rebase aborted, clone left clean). Conflicts: " +
        `${conflicted.join(", ") || pull.stderr || "unknown"}`,
    };
  }
  return { ok: true, detail: pull.stdout.split("\n")[0] ?? "up to date" };
}
