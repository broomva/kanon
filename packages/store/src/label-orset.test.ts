/**
 * BRO-1678 — labelIds as an OR-Set (label-as-edges) convergence contract.
 *
 * The acceptance test for the fix: `labelIds` used to be a whole-array LWW
 * field, so two clones that concurrently attach *different* labels dropped one
 * side (LWW kept one array). Labels are now `issue_label` relate/unrelate edge
 * entities keyed by a DETERMINISTIC id per `(issueId, labelId)`, so each pair
 * is its own LWW register: concurrent adds of different labels union, and
 * add/remove of the same label resolves by highest event id (per-entity LWW).
 *
 * "Convergence is tested, not assumed" — the property test drives random
 * concurrent add/remove sequences and asserts the projected `issue_labels`
 * equals the LWW-element-set oracle, independent of the order events land in
 * the log (two write orders → identical projection).
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEvent, issueLabelId, type KanonEvent } from "@kanon/core";
import fc from "fast-check";
import { openProjection } from "./projection";
import { getIssue } from "./queries";
import { entityId, TEST_ACTOR, testId, WORKSPACE, writeEvents } from "./testing";

const dirs: string[] = [];
function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "kanon-label-"));
  dirs.push(dir);
  return dir;
}
function cleanup(): void {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

const ISSUE = entityId(100);
const LABELS = Array.from({ length: 6 }, (_, i) => entityId(200 + i));
/** Checked label accessor — keeps `noUncheckedIndexedAccess` happy in asserts. */
function L(i: number): string {
  const v = LABELS[i];
  if (v === undefined) throw new Error(`no label ${i}`);
  return v;
}
const JUNE = "2026-06-10T10:00:00.000Z";

/** Minimal base: workspace, team (with key), one state, N labels, one issue. */
function baseEvents(
  labelCount: number,
  extraIssueData: Record<string, unknown> = {},
): KanonEvent[] {
  const ev = (seq: number, op: "create", model: string, modelId: string, data: object) =>
    createEvent({
      workspace: WORKSPACE,
      actor: TEST_ACTOR,
      op,
      // biome-ignore lint/suspicious/noExplicitAny: test builds arbitrary model strings
      model: model as any,
      modelId,
      data: data as Record<string, unknown>,
      id: testId(seq),
      ts: JUNE,
    });
  const team = entityId(0);
  const out: KanonEvent[] = [
    ev(1, "create", "workspace", entityId(99), { slug: WORKSPACE }),
    ev(2, "create", "team", team, { key: "BRO", name: "Broomva" }),
    ev(3, "create", "workflow_state", entityId(1), {
      teamId: team,
      name: "Todo",
      type: "unstarted",
      position: 0,
    }),
  ];
  for (let i = 0; i < labelCount; i++) {
    out.push(ev(10 + i, "create", "label", LABELS[i] as string, { teamId: team, name: `L${i}` }));
  }
  out.push(
    ev(30, "create", "issue", ISSUE, {
      teamId: team,
      number: 1,
      title: "Labelled",
      stateId: entityId(1),
      ...extraIssueData,
    }),
  );
  return out;
}

/** An `issue_label` edge event: `relate` attaches, `unrelate` detaches. */
function edgeEvent(seq: number, labelId: string, attach: boolean): KanonEvent {
  return createEvent({
    workspace: WORKSPACE,
    actor: TEST_ACTOR,
    op: attach ? "relate" : "unrelate",
    model: "issue_label",
    modelId: issueLabelId(ISSUE, labelId),
    data: { issueId: ISSUE, labelId },
    id: testId(seq),
    ts: JUNE,
  });
}

/** Project events (in the given write order) and read the issue's labels back. */
function projectLabels(writeOrder: KanonEvent[]): string[] {
  const dir = tempRepo();
  writeEvents(dir, writeOrder);
  const projection = openProjection(dir, { onWarn: () => {} });
  projection.rebuild();
  const issue = getIssue(projection.db, ISSUE);
  projection.close();
  return (issue?.labelIds ?? []).slice().sort();
}

describe("labelIds OR-Set (label-as-edges) — BRO-1678", () => {
  test("REGRESSION: concurrent add of two different labels — both survive", () => {
    // Two clones, neither saw the other's write; in the merged log they are
    // just two relates. The old whole-array LWW dropped one; edges union.
    const events = [
      ...baseEvents(2),
      edgeEvent(100, L(0), true), // clone A attaches L0
      edgeEvent(101, L(1), true), // clone B attaches L1
    ];
    expect(projectLabels(events)).toEqual([L(0), L(1)].sort());
    cleanup();
  });

  test("add/remove of the SAME label resolves by highest event id (per-entity LWW)", () => {
    const base = baseEvents(1);
    // remove wins when it is later...
    expect(
      projectLabels([...base, edgeEvent(100, L(0), true), edgeEvent(101, L(0), false)]),
    ).toEqual([]);
    cleanup();
    // ...and add wins when IT is later (re-attach after a remove).
    expect(
      projectLabels([...base, edgeEvent(100, L(0), false), edgeEvent(101, L(0), true)]),
    ).toEqual([L(0)]);
    cleanup();
  });

  test("MIGRATION: a legacy whole-array label removed via an unrelate edge is suppressed", () => {
    // The 1,666-issue import carries labels as a whole-array `labelIds` field.
    // A later remove emits an unrelate on the deterministic edge — with no
    // prior relate — and the projection must read the pair as removed.
    const base = baseEvents(2, { labelIds: [L(0), L(1)] });
    const events = [...base, edgeEvent(100, L(0), false)]; // remove legacy L0
    expect(projectLabels(events)).toEqual([L(1)]);
    cleanup();
  });

  test("MIGRATION: a legacy label re-added after removal comes back (edge > array)", () => {
    const base = baseEvents(2, { labelIds: [L(0)] });
    const events = [
      ...base,
      edgeEvent(100, L(0), false), // remove legacy L0
      edgeEvent(101, L(0), true), // re-attach L0
    ];
    expect(projectLabels(events)).toEqual([L(0)]);
    cleanup();
  });

  test("PROPERTY: projected labels == LWW-element-set oracle, independent of write order", () => {
    const opsArb = fc.array(
      fc.record({ label: fc.integer({ min: 0, max: LABELS.length - 1 }), attach: fc.boolean() }),
      { minLength: 0, maxLength: 40 },
    );
    fc.assert(
      fc.property(opsArb, fc.integer({ min: 0, max: 2 ** 31 }), (ops, seed) => {
        const base = baseEvents(LABELS.length);
        // seq order = causal (event-id) order; the oracle is the last op per label.
        const edges = ops.map((op, i) => edgeEvent(100 + i, L(op.label), op.attach));
        const last = new Map<number, boolean>();
        for (const op of ops) last.set(op.label, op.attach);
        const expected = [...last.entries()]
          .filter(([, attach]) => attach)
          .map(([label]) => LABELS[label] as string)
          .sort();

        const all = [...base, ...edges];
        // Two independent write orders (the log is a set; replay sorts by id).
        const shuffled = fc.sample(fc.shuffledSubarray(all, { minLength: all.length }), {
          seed,
          numRuns: 1,
        })[0] as KanonEvent[];

        expect(projectLabels(all)).toEqual(expected);
        expect(projectLabels(shuffled)).toEqual(expected);
        cleanup();
      }),
      { numRuns: 60 },
    );
    cleanup();
  });
});
