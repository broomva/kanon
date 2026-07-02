import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import type { KanonEvent } from "./index";
import { unionMerge, unionMergeWithReport } from "./merge";
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

  test("first occurrence wins on duplicate ids", () => {
    const first = issueCreate(1, 0, { title: "kept" });
    const second = issueCreate(1, 0, { title: "discarded" });
    const merged = unionMerge([first], [second]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.data).toEqual({ title: "kept" });
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

  test("duplicate id with different content is kept-first and reported", () => {
    const kept = issueCreate(1, 0, { title: "kept" });
    const discarded = issueCreate(1, 0, { title: "discarded" });
    const report = unionMergeWithReport([kept], [discarded]);
    expect(report.events).toEqual([kept]);
    expect(report.duplicatesDropped).toBe(1);
    expect(report.conflicts).toEqual([{ id: kept.id, kept, discarded }]);
  });

  test("PROPERTY: merge output is independent of stream arrangement", () => {
    const arb = fc
      .array(
        fc.record({
          op: fc.constantFrom("create", "update", "archive", "delete") as fc.Arbitrary<
            "create" | "update" | "archive" | "delete"
          >,
          entity: fc.integer({ min: 0, max: 4 }),
          title: fc.string({ maxLength: 5 }),
        }),
        { minLength: 1, maxLength: 30 },
      )
      .map((specs) =>
        specs.map((spec, i) =>
          makeEvent({
            seq: i + 1,
            op: spec.op,
            model: "issue",
            entity: spec.entity,
            data: { title: spec.title },
          }),
        ),
      )
      .chain((events) =>
        fc.record({
          events: fc.constant(events),
          shuffled: fc.shuffledSubarray(events, {
            minLength: events.length,
            maxLength: events.length,
          }),
          cut: fc.integer({ min: 0, max: events.length }),
        }),
      );
    fc.assert(
      fc.property(arb, ({ events, shuffled, cut }) => {
        const baseline = unionMerge(events);
        const split = unionMerge(shuffled.slice(0, cut), shuffled.slice(cut), events);
        expect(split).toEqual(baseline);
      }),
      { numRuns: 200 },
    );
  });
});
