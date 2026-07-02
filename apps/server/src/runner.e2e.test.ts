/**
 * E2E: the reference runner (examples/runner/run.ts) against a live server —
 * proves the standalone contract. The runner polls the feed with a cursor
 * file, sees the delegation to its actor, and executes RUNNER_CMD with
 * $KANON_ISSUE substituted.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { boot, cleanup, ok, tempDir, waitFor } from "./test-helpers";

const RUNNER = join(import.meta.dir, "..", "..", "..", "examples", "runner", "run.ts");

let runner: ReturnType<typeof Bun.spawn> | undefined;

afterEach(() => {
  runner?.kill();
  runner = undefined;
  cleanup();
});

describe("reference runner", () => {
  test("delegating an issue triggers RUNNER_CMD with the identifier", async () => {
    const { url } = boot();
    const scratch = tempDir("kanon-runner-");
    const outFile = join(scratch, "out.txt");
    const cursorFile = join(scratch, "cursor");

    runner = Bun.spawn([process.execPath, RUNNER], {
      env: {
        ...process.env,
        KANON_URL: url,
        KANON_API_KEY: "agent-key",
        RUNNER_ACTOR: "runner-bot",
        RUNNER_CMD: `echo "$KANON_ISSUE" >> ${outFile}`,
        RUNNER_POLL_MS: "100",
        RUNNER_CURSOR_FILE: cursorFile,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    await ok(url, "POST", "/v1/teams", { key: "BRO", name: "Broomva" });
    // create + delegate: the actor mint (name "runner-bot") and the issue
    // create (delegateId) both ride the feed; the runner derives the match.
    await ok(url, "POST", "/v1/issues", {
      team: "BRO",
      title: "Delegated to the runner",
      delegate: "runner-bot",
    });

    const content = await waitFor(
      () => {
        if (!existsSync(outFile)) return undefined;
        const text = readFileSync(outFile, "utf8");
        return text.includes("BRO-1") ? text : undefined;
      },
      10_000,
      "runner output file",
    );
    expect(content.trim()).toBe("BRO-1");

    // The cursor persisted — the loop is resumable by construction.
    await waitFor(
      () =>
        existsSync(cursorFile) && readFileSync(cursorFile, "utf8").length > 0 ? true : undefined,
      5000,
      "cursor file",
    );

    // An unrelated issue (no delegate, backlog state) does NOT trigger.
    await ok(url, "POST", "/v1/issues", { team: "BRO", title: "Not delegated" });
    await Bun.sleep(400);
    expect(readFileSync(outFile, "utf8").trim()).toBe("BRO-1");
  });
});
