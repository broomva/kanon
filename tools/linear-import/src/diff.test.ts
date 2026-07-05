import { describe, expect, test } from "bun:test";
import {
  diffIssues,
  type KanonCatalog,
  type KanonIssue,
  type NormIssue,
  normalizeKanonIssues,
  normalizeLinearIssue,
  UNRESOLVED_PREFIX,
} from "./diff";
import type { LinearIssueExport } from "./types";

function norm(overrides: Partial<NormIssue> & { linearId: string }): NormIssue {
  return {
    identifier: overrides.linearId,
    title: "T",
    description: "",
    priority: 0,
    stateLinearId: "",
    assigneeLinearId: "",
    projectLinearId: "",
    parentLinearId: "",
    labelLinearIds: [],
    archived: false,
    ...overrides,
  };
}

describe("diffIssues", () => {
  test("identical sets converge with everything matched", () => {
    const a = [norm({ linearId: "L1", title: "One" }), norm({ linearId: "L2", title: "Two" })];
    const b = [norm({ linearId: "L2", title: "Two" }), norm({ linearId: "L1", title: "One" })];
    const report = diffIssues(a, b);
    expect(report.converged).toBe(true);
    expect(report.matched).toBe(2);
    expect(report.mismatches).toEqual([]);
    expect(report.onlyInLinear).toEqual([]);
    expect(report.onlyInKanon).toEqual([]);
  });

  test("a hard-field difference is a mismatch and breaks convergence", () => {
    const linear = [norm({ linearId: "L1", stateLinearId: "S-DONE" })];
    const kanon = [norm({ linearId: "L1", stateLinearId: "S-TODO" })];
    const report = diffIssues(linear, kanon);
    expect(report.converged).toBe(false);
    expect(report.matched).toBe(0);
    expect(report.mismatches).toHaveLength(1);
    expect(report.mismatches[0]?.fields).toEqual([
      { field: "stateLinearId", linear: "S-DONE", kanon: "S-TODO" },
    ]);
  });

  test("labels compare as an order-independent set", () => {
    const linear = [norm({ linearId: "L1", labelLinearIds: ["a", "b"] })];
    // Genuinely reversed order — exercises the order-independence claim.
    const swapped = [norm({ linearId: "L1", labelLinearIds: ["b", "a"] })];
    expect(diffIssues(linear, swapped).converged).toBe(true);
    const missingLabel = [norm({ linearId: "L1", labelLinearIds: ["a"] })];
    const report = diffIssues(linear, missingLabel);
    expect(report.converged).toBe(false);
    expect(report.mismatches[0]?.fields[0]?.field).toBe("labels");
  });

  test("a description-only difference is soft — reported but still converged", () => {
    const linear = [norm({ linearId: "L1", description: "old body" })];
    const kanon = [norm({ linearId: "L1", description: "new body" })];
    const report = diffIssues(linear, kanon);
    expect(report.converged).toBe(true);
    expect(report.matched).toBe(0);
    expect(report.mismatches).toEqual([]);
    expect(report.descriptionOnly).toEqual([{ linearId: "L1", identifier: "L1" }]);
  });

  test("an issue missing from the shadow breaks convergence (onlyInLinear)", () => {
    const report = diffIssues(
      [norm({ linearId: "L1" }), norm({ linearId: "L2" })],
      [norm({ linearId: "L1" })],
    );
    expect(report.converged).toBe(false);
    expect(report.onlyInLinear).toEqual([{ linearId: "L2", identifier: "L2" }]);
  });

  test("an issue gone from Linear is a known-limit deletion — reported, not a convergence break", () => {
    const report = diffIssues(
      [norm({ linearId: "L1" })],
      [norm({ linearId: "L1" }), norm({ linearId: "L2", identifier: "BRO-9" })],
    );
    expect(report.converged).toBe(true);
    expect(report.onlyInKanon).toEqual([{ linearId: "L2", identifier: "BRO-9" }]);
  });

  test("kanonNative passes through and never affects convergence", () => {
    const report = diffIssues([norm({ linearId: "L1" })], [norm({ linearId: "L1" })], 4);
    expect(report.kanonNative).toBe(4);
    expect(report.converged).toBe(true);
  });
});

describe("normalizeLinearIssue", () => {
  const base: LinearIssueExport = {
    linearId: "L1",
    teamLinearId: "T1",
    number: 5,
    identifier: "BRO-5",
    title: "Ship it",
    labelLinearIds: [],
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00Z",
    relations: [],
  };

  test("applies defaults and trims description", () => {
    const n = normalizeLinearIssue({ ...base, description: "  hi  " });
    expect(n.description).toBe("hi");
    expect(n.priority).toBe(0);
    expect(n.stateLinearId).toBe("");
    expect(n.assigneeLinearId).toBe("");
    expect(n.archived).toBe(false);
  });

  test("labels are deduped and sorted; archivedAt makes archived true", () => {
    const n = normalizeLinearIssue({
      ...base,
      labelLinearIds: ["b", "a", "b"],
      archivedAt: "2026-07-02T00:00:00Z",
    });
    expect(n.labelLinearIds).toEqual(["a", "b"]);
    expect(n.archived).toBe(true);
  });
});

describe("normalizeKanonIssues", () => {
  const catalog: KanonCatalog = {
    states: [{ id: "st-ulid", data: { linearId: "S-LIN" } }],
    projects: [{ id: "pr-ulid", data: { linearId: "P-LIN" } }],
    labels: [
      { id: "lb-a", data: { linearId: "LA" } },
      { id: "lb-b", data: { linearId: "LB" } },
    ],
    actors: [{ id: "ac-ulid", data: { linearId: "A-LIN" } }],
  };

  function kIssue(overrides: Partial<KanonIssue> & { id: string }): KanonIssue {
    return {
      identifier: "BRO-1",
      title: "T",
      description: null,
      stateId: null,
      priority: null,
      assigneeId: null,
      projectId: null,
      parentId: null,
      labelIds: [],
      archivedAt: null,
      ...overrides,
    };
  }

  test("cross-walks every ULID reference to its Linear UUID", () => {
    const parent = kIssue({ id: "iss-parent", data: { linearId: "L-PARENT" } });
    const child = kIssue({
      id: "iss-child",
      data: { linearId: "L-CHILD" },
      stateId: "st-ulid",
      assigneeId: "ac-ulid",
      projectId: "pr-ulid",
      parentId: "iss-parent",
      labelIds: ["lb-b", "lb-a"],
      priority: 2,
    });
    const { issues, native } = normalizeKanonIssues(catalog, [parent, child]);
    expect(native).toBe(0);
    const c = issues.find((i) => i.linearId === "L-CHILD");
    expect(c).toMatchObject({
      stateLinearId: "S-LIN",
      assigneeLinearId: "A-LIN",
      projectLinearId: "P-LIN",
      parentLinearId: "L-PARENT",
      labelLinearIds: ["LA", "LB"],
      priority: 2,
    });
  });

  test("issues without a linearId are counted as native, not normalized", () => {
    const { issues, native } = normalizeKanonIssues(catalog, [
      kIssue({ id: "iss-1", data: { linearId: "L1" } }),
      kIssue({ id: "iss-2", data: null }),
      kIssue({ id: "iss-3" }),
    ]);
    expect(native).toBe(2);
    expect(issues.map((i) => i.linearId)).toEqual(["L1"]);
  });

  test("an unresolvable reference is TAGGED, not collapsed to empty", () => {
    const { issues } = normalizeKanonIssues(catalog, [
      kIssue({
        id: "iss-1",
        data: { linearId: "L1" },
        stateId: "unknown-ulid",
        labelIds: ["gone"],
      }),
    ]);
    expect(issues[0]?.stateLinearId).toBe(`${UNRESOLVED_PREFIX}unknown-ulid`);
    expect(issues[0]?.labelLinearIds).toEqual([`${UNRESOLVED_PREFIX}gone`]);
  });

  test("a dangling Kanon ref does NOT false-match a legitimately-empty Linear side", () => {
    // Kanon points at a since-tombstoned assignee (resolves to a sentinel);
    // Linear has the issue genuinely unassigned (""). This MUST be drift.
    const kanon = normalizeKanonIssues(catalog, [
      kIssue({ id: "iss-1", data: { linearId: "L1" }, assigneeId: "tombstoned-ulid" }),
    ]).issues;
    const linear = [
      normalizeLinearIssue({
        linearId: "L1",
        teamLinearId: "T1",
        number: 1,
        identifier: "BRO-1",
        title: "T",
        labelLinearIds: [],
        createdAt: "2026-07-01T00:00:00Z",
        updatedAt: "2026-07-01T00:00:00Z",
        relations: [],
      }),
    ];
    const report = diffIssues(linear, kanon);
    expect(report.converged).toBe(false);
    expect(report.mismatches[0]?.fields[0]?.field).toBe("assigneeLinearId");
  });
});
