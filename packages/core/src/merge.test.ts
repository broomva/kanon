import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import type { KanonEvent } from "./index";
import { unionMerge, unionMergeWithReport } from "./merge";
import { replay } from "./replay";
import { stateChecksum } from "./snapshot";
import { stableStringify } from "./stable";
import { makeEvent } from "./testing";

function issueCreate(seq: number, entity: number, data?: Record<string, unknown>): KanonEvent {
  return makeEvent({ seq, op: "create", model: "issue", entity, data: data ?? {} });
}

describe("unionMerge", () => {
  test("sorts the union ascending by event id", () => {
    const a = issueCreate(3, 0);
    const b = issueCreate(1, 1);
    const c = issueCreate(2, 2);
    expect(unionMerge([a], [b, c]).map((e) => e.id)).toEqual([b.id, c.id, a.id]);
  });

  test("dedupes identical events across streams", () => {
    const a = issueCreate(1, 0, { title: "one" });
    const b = issueCreate(2, 1, { title: "two" });
    const merged = unionMerge([a, b], [b, a], [a]);
    expect(merged).toEqual([a, b]);
  });

  test("conflicting duplicate ids resolve by content tie-break, not arrival order", () => {
    const small = issueCreate(1, 0, { title: "aaa" });
    const large = issueCreate(1, 0, { title: "zzz" });
    expect(stableStringify(small) < stableStringify(large)).toBe(true);
    // Both arrangements keep the same occurrence — the smaller serialization.
    expect(unionMerge([small], [large])).toEqual([small]);
    expect(unionMerge([large], [small])).toEqual([small]);
    expect(unionMerge([large, small])).toEqual([small]);
  });

  test("accepts arbitrary iterables, not just arrays", () => {
    function* stream(): Generator<KanonEvent> {
      yield issueCreate(2, 0);
      yield issueCreate(1, 1);
    }
    expect(unionMerge(stream()).map((e) => e.id)).toEqual([
      issueCreate(1, 1).id,
      issueCreate(2, 0).id,
    ]);
  });
});

describe("unionMergeWithReport", () => {
  test("identical duplicates are dropped silently, counted, not conflicts", () => {
    const a = issueCreate(1, 0, { title: "same" });
    const clone: KanonEvent = JSON.parse(JSON.stringify(a));
    const report = unionMergeWithReport([a], [clone]);
    expect(report.events).toEqual([a]);
    expect(report.duplicatesDropped).toBe(1);
    expect(report.conflicts).toEqual([]);
  });

  test("key order does not make two occurrences a conflict", () => {
    const a = issueCreate(1, 0, { title: "same", state: "backlog" });
    const reordered: KanonEvent = { ...a, data: { state: "backlog", title: "same" } };
    const report = unionMergeWithReport([a], [reordered]);
    expect(report.conflicts).toEqual([]);
    expect(report.duplicatesDropped).toBe(1);
  });

  test("duplicate id with different content keeps the tie-break winner and reports the conflict", () => {
    const winner = issueCreate(1, 0, { title: "aaa" });
    const loser = issueCreate(1, 0, { title: "zzz" });
    for (const streams of [
      [[winner], [loser]],
      [[loser], [winner]],
    ]) {
      const report = unionMergeWithReport(...streams);
      expect(report.events).toEqual([winner]);
      expect(report.duplicatesDropped).toBe(1);
      expect(report.conflicts).toEqual([{ id: winner.id, kept: winner, discarded: loser }]);
    }
  });

  test("REGRESSION: conflicting duplicates with different ts converge on one ts (fix #4)", () => {
    // Same id, different ts AND content — the kept occurrence (and therefore
    // the ts that stamps createdAt/archivedAt on replay) must not depend on
    // arrangement.
    const a = makeEvent({
      seq: 1,
      op: "create",
      model: "issue",
      entity: 0,
      data: { title: "alpha" },
      tsSeed: 3,
    });
    const b = makeEvent({
      seq: 1,
      op: "create",
      model: "issue",
      entity: 0,
      data: { title: "beta" },
      tsSeed: 9,
    });
    const ab = unionMerge([a], [b]);
    const ba = unionMerge([b], [a]);
    expect(ab).toEqual(ba);
    expect(ab[0]?.ts).toBe(ba[0]?.ts ?? "");
    const expected = stableStringify(a) < stableStringify(b) ? a : b;
    expect(ab[0]).toEqual(expected);
    expect(stateChecksum(replay(ab))).toBe(stateChecksum(replay(ba)));
  });

  test("PROPERTY: merged events are arrangement-independent, even under conflicting duplicate ids (G1)", () => {
    const arb = fc
      .record({
        specs: fc.array(
          fc.record({
            op: fc.constantFrom("create", "update", "archive", "delete") as fc.Arbitrary<
              "create" | "update" | "archive" | "delete"
            >,
            entity: fc.integer({ min: 0, max: 4 }),
            title: fc.string({ maxLength: 5 }),
            tsSeed: fc.integer({ min: 0, max: 15 }),
          }),
          { minLength: 1, maxLength: 25 },
        ),
        // Byzantine duplicates: same seq (= same id) as some base event but
        // independently generated content and ts.
        dupes: fc.array(
          fc.record({
            index: fc.nat(),
            title: fc.string({ maxLength: 5 }),
            tsSeed: fc.integer({ min: 0, max: 15 }),
          }),
          { maxLength: 5 },
        ),
      })
      .map(({ specs, dupes }) => {
        const events = specs.map((spec, i) =>
          makeEvent({
            seq: i + 1,
            op: spec.op,
            model: "issue",
            entity: spec.entity,
            data: { title: spec.title },
            tsSeed: spec.tsSeed,
          }),
        );
        const conflictEvents = dupes.map((dupe) => {
          const at = dupe.index % specs.length;
          const base = specs[at];
          if (base === undefined) {
            throw new Error("unreachable: index is taken modulo specs.length");
          }
          return makeEvent({
            seq: at + 1,
            op: base.op,
            model: "issue",
            entity: base.entity,
            data: { title: dupe.title },
            tsSeed: dupe.tsSeed,
          });
        });
        return [...events, ...conflictEvents];
      })
      .chain((all) =>
        fc.record({
          all: fc.constant(all),
          shuffled: fc.shuffledSubarray(all, { minLength: all.length, maxLength: all.length }),
          cut: fc.integer({ min: 0, max: all.length }),
        }),
      );
    fc.assert(
      fc.property(arb, ({ all, shuffled, cut }) => {
        const baseline = unionMergeWithReport(all);
        const rearranged = unionMergeWithReport(shuffled.slice(0, cut), shuffled.slice(cut));
        // The canonical output — and therefore replayed state — must be a
        // pure function of the input set. (The conflicts list is diagnostic
        // and may pair differently across arrangements; only its presence is
        // arrangement-independent.)
        expect(rearranged.events).toEqual(baseline.events);
        expect(rearranged.conflicts.length > 0).toBe(baseline.conflicts.length > 0);
        expect(stateChecksum(replay(rearranged.events))).toBe(
          stateChecksum(replay(baseline.events)),
        );
      }),
      { numRuns: 200 },
    );
  });
});
