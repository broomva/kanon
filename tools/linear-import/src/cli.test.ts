import { describe, expect, test } from "bun:test";
import fixtureJson from "../fixtures/export.small.json";
import { CliError, normalizeExport, parseArgs } from "./cli";
import type { LinearExport } from "./types";

function freshExport(): Record<string, unknown> {
  return structuredClone(fixtureJson) as unknown as Record<string, unknown>;
}

describe("parseArgs", () => {
  test("parses the documented flag set", () => {
    const flags = parseArgs([
      "--data-repo",
      "/tmp/repo",
      "--fixture",
      "export.json",
      "--save-export",
      "snap.json",
      "--dry-run",
      "--json",
    ]);
    expect(flags.get("data-repo")).toBe("/tmp/repo");
    expect(flags.get("fixture")).toBe("export.json");
    expect(flags.get("save-export")).toBe("snap.json");
    expect(flags.get("dry-run")).toBe(true);
    expect(flags.get("json")).toBe(true);
  });

  test("supports --flag=value form", () => {
    const flags = parseArgs(["--data-repo=/tmp/repo", "--live"]);
    expect(flags.get("data-repo")).toBe("/tmp/repo");
    expect(flags.get("live")).toBe(true);
  });

  test("rejects unknown flags (a --dryrun typo must not silently import)", () => {
    expect(() => parseArgs(["--data-repo", "/tmp/repo", "--dryrun"])).toThrow(CliError);
    expect(() => parseArgs(["--dryrun"])).toThrow("unknown flag: --dryrun");
  });

  test("rejects a value flag missing its value", () => {
    // reproduced defect: --save-export swallowed --dry-run and lost the export
    expect(() => parseArgs(["--save-export", "--dry-run"])).toThrow(
      "--save-export requires a value",
    );
    expect(() => parseArgs(["--data-repo"])).toThrow("--data-repo requires a value");
    expect(() => parseArgs(["--fixture="])).toThrow("--fixture requires a value");
  });

  test("rejects boolean flags given a value", () => {
    expect(() => parseArgs(["--dry-run=true"])).toThrow("--dry-run does not take a value");
  });

  test("rejects stray positional arguments", () => {
    expect(() => parseArgs(["import", "--live"])).toThrow("unexpected argument: import");
  });
});

describe("normalizeExport", () => {
  test("accepts the reference fixture and defaults missing lists", () => {
    const exp = normalizeExport(freshExport());
    expect(exp.workspace).toBe("broomva");
    expect(exp.issues.length).toBe(4);

    const minimal = normalizeExport({ workspace: "broomva" }) as LinearExport;
    expect(minimal.teams).toEqual([]);
    expect(minimal.issues).toEqual([]);
  });

  test("rejects non-object documents and missing workspace", () => {
    expect(() => normalizeExport([])).toThrow(CliError);
    expect(() => normalizeExport({ workspace: "" })).toThrow(
      "export.workspace must be a non-empty string",
    );
  });

  test("rejects any entity without a non-empty linearId", () => {
    // reproduced defect: a missing linearId minted a duplicate issue per re-run
    const missingIssueId = freshExport();
    delete (missingIssueId.issues as Record<string, unknown>[])[0]?.linearId;
    expect(() => normalizeExport(missingIssueId)).toThrow(
      "export.issues[0]: linearId must be a non-empty string",
    );

    const emptyLabelId = freshExport();
    const label = (emptyLabelId.labels as Record<string, unknown>[])[0];
    if (label !== undefined) label.linearId = "";
    expect(() => normalizeExport(emptyLabelId)).toThrow(
      "export.labels[0]: linearId must be a non-empty string",
    );

    const badState = freshExport();
    const team = (badState.teams as Record<string, unknown>[])[0];
    const states = team?.states as Record<string, unknown>[] | undefined;
    if (states?.[0] !== undefined) delete states[0].linearId;
    expect(() => normalizeExport(badState)).toThrow(
      "export.teams[0].states[0]: linearId must be a non-empty string",
    );
  });

  test("rejects issues without teamLinearId or number", () => {
    const noTeam = freshExport();
    delete (noTeam.issues as Record<string, unknown>[])[1]?.teamLinearId;
    expect(() => normalizeExport(noTeam)).toThrow("teamLinearId must be a non-empty string");

    const badNumber = freshExport();
    const issue = (badNumber.issues as Record<string, unknown>[])[1];
    if (issue !== undefined) issue.number = "1644";
    expect(() => normalizeExport(badNumber)).toThrow("number must be a number");
  });

  test("rejects unparseable timestamps before any write", () => {
    const badUpdatedAt = freshExport();
    const issue = (badUpdatedAt.issues as Record<string, unknown>[])[0];
    if (issue !== undefined) issue.updatedAt = "not a date";
    expect(() => normalizeExport(badUpdatedAt)).toThrow("updatedAt must be a parseable timestamp");

    const badComment = freshExport();
    const comment = (badComment.comments as Record<string, unknown>[])[0];
    if (comment !== undefined) comment.createdAt = "yesterday-ish";
    expect(() => normalizeExport(badComment)).toThrow("createdAt must be a parseable timestamp");

    // parseable-but-exotic representations are allowed; transform normalizes them
    const exotic = freshExport();
    const exoticIssue = (exotic.issues as Record<string, unknown>[])[0];
    if (exoticIssue !== undefined) exoticIssue.updatedAt = "2026-06-27T19:30:00.000+03:00";
    expect(() => normalizeExport(exotic)).not.toThrow();
  });
});
