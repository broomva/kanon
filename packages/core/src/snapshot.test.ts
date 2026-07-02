import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import type { KanonEvent, Op } from "./index";
import { unionMerge } from "./merge";
import { replay, replayMerged } from "./replay";
import { restoreSnapshot, SNAPSHOT_VERSION, stateChecksum, takeSnapshot } from "./snapshot";
import { fnv1a64, stableStringify } from "./stable";
import { entityId, makeEvent, mustGetEntity } from "./testing";

const OP_POOL = ["create", "update", "archive", "unarchive", "delete"] as const satisfies Op[];

const arbEvents: fc.Arbitrary<KanonEvent[]> = fc
  .array(
    fc.record({
      op: fc.constantFrom(...OP_POOL),
      entity: fc.integer({ min: 0, max: 5 }),
      title: fc.string({ maxLength: 8 }),
    }),
    { minLength: 1, maxLength: 40 },
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
  );

describe("snapshot properties", () => {
  test("PROPERTY: snapshot equivalence — restore at any split point, replay the rest, same checksum", () => {
    const arb = arbEvents.chain((events) =>
      fc.record({
        events: fc.constant(events),
        k: fc.integer({ min: 0, max: events.length }),
      }),
    );
    fc.assert(
      fc.property(arb, ({ events, k }) => {
        const sorted = unionMerge(events);
        const full = stateChecksum(replay(sorted));

        const head = replay(sorted.slice(0, k));
        const resumed = restoreSnapshot(takeSnapshot(head));
        replay(sorted.slice(k), resumed);
        expect(stateChecksum(resumed)).toBe(full);
      }),
      { numRuns: 200 },
    );
  });

  test("PROPERTY: identical states from different partitions serialize identically", () => {
    const arb = arbEvents.chain((events) =>
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
        const a = takeSnapshot(replayMerged(events));
        const b = takeSnapshot(replayMerged(shuffled.slice(0, cut), shuffled.slice(cut)));
        expect(JSON.stringify(b)).toBe(JSON.stringify(a));
      }),
      { numRuns: 200 },
    );
  });

  test("PROPERTY: snapshots survive a JSON round-trip", () => {
    fc.assert(
      fc.property(arbEvents, (events) => {
        const state = replayMerged(events);
        const revived = restoreSnapshot(JSON.parse(JSON.stringify(takeSnapshot(state))));
        expect(stateChecksum(revived)).toBe(stateChecksum(state));
        expect(revived.cursor).toBe(state.cursor);
      }),
      { numRuns: 200 },
    );
  });
});

describe("snapshot mechanics", () => {
  const history = [
    makeEvent({ seq: 2, op: "create", model: "project", entity: 1, data: { title: "p" } }),
    makeEvent({ seq: 1, op: "create", model: "issue", entity: 2, data: { z: 1, a: 2 } }),
    makeEvent({ seq: 3, op: "create", model: "issue", entity: 0, data: { title: "i" } }),
  ];

  test("emits models, entity ids, fields, and fieldVersions in sorted order", () => {
    const snap = takeSnapshot(replayMerged(history));
    expect(Object.keys(snap.entities)).toEqual(["issue", "project"]);
    expect(Object.keys(snap.entities.issue ?? {})).toEqual(
      [entityId(0), entityId(2)].sort((a, b) => a.localeCompare(b)),
    );
    expect(Object.keys(snap.entities.issue?.[entityId(2)]?.fields ?? {})).toEqual(["a", "z"]);
    const versionKeys = Object.keys(snap.fieldVersions);
    expect(versionKeys).toEqual([...versionKeys].sort());
  });

  test("restore rebuilds a live state that keeps replaying", () => {
    const state = replayMerged(history);
    const restored = restoreSnapshot(takeSnapshot(state));
    replay(
      [makeEvent({ seq: 4, op: "update", model: "issue", entity: 0, data: { title: "i2" } })],
      restored,
    );
    expect(mustGetEntity(restored, "issue", entityId(0)).fields.title).toBe("i2");
    // The source state is untouched — restore copies entity records.
    expect(mustGetEntity(state, "issue", entityId(0)).fields.title).toBe("i");
  });

  test("rejects unknown snapshot versions", () => {
    const snap = takeSnapshot(replayMerged(history));
    const future = { ...snap, v: 2 } as unknown as ReturnType<typeof takeSnapshot>;
    expect(() => restoreSnapshot(future)).toThrow("unsupported snapshot version");
    expect(snap.v).toBe(SNAPSHOT_VERSION);
  });

  test("empty state snapshots and checksums deterministically", () => {
    const empty = replay([]);
    expect(takeSnapshot(empty)).toEqual({
      v: 1,
      cursor: null,
      entities: {},
      fieldVersions: {},
    });
    expect(stateChecksum(empty)).toBe(stateChecksum(replay([])));
    expect(stateChecksum(empty)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("stableStringify / fnv1a64", () => {
  test("sorts object keys at every depth; arrays keep order", () => {
    expect(stableStringify({ b: 1, a: { d: [2, { y: 1, x: 0 }], c: 3 } })).toBe(
      '{"a":{"c":3,"d":[2,{"x":0,"y":1}]},"b":1}',
    );
  });

  test("matches JSON.stringify semantics for edge values", () => {
    expect(stableStringify({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(stableStringify([undefined, Number.NaN, 1])).toBe("[null,null,1]");
    expect(stableStringify(null)).toBe("null");
    expect(stableStringify('quote"s')).toBe(JSON.stringify('quote"s'));
  });

  test("fnv1a64 of the empty string is the FNV-1a 64-bit offset basis", () => {
    expect(fnv1a64("")).toBe("cbf29ce484222325");
  });

  test("fnv1a64 is deterministic and input-sensitive", () => {
    expect(fnv1a64("kanon")).toBe(fnv1a64("kanon"));
    expect(fnv1a64("kanon")).not.toBe(fnv1a64("kanoN"));
    expect(fnv1a64("kanon")).toMatch(/^[0-9a-f]{16}$/);
  });
});
