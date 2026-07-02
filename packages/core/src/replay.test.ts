import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { type KanonEvent, type Model, type Op, parseEventLine, serializeEvent } from "./index";
import { unionMerge } from "./merge";
import {
  applyEvent,
  createWorldState,
  DELETED_FIELD,
  fieldVersionKey,
  ReplayDivergenceError,
  ReplayOrderError,
  ReplayStateError,
  replay,
  replayMerged,
} from "./replay";
import { stateChecksum } from "./snapshot";
import { stableStringify } from "./stable";
import { entityId, makeEvent, mustGetEntity, testTs } from "./testing";

const OP_POOL = [
  "create",
  "update",
  "archive",
  "unarchive",
  "delete",
  "relate",
  "unrelate",
] as const satisfies Op[];
const MODEL_POOL = ["issue", "project", "label", "issue_relation"] as const satisfies Model[];
const FIELD_POOL = ["title", "state", "priority", "estimate"] as const;

const arbScalar = fc.oneof(
  fc.string({ maxLength: 6 }),
  fc.integer(),
  fc.boolean(),
  fc.constant(null),
);
// G3: nested plain objects/arrays alongside scalars.
const arbValue = fc.oneof(
  arbScalar,
  fc.array(arbScalar, { maxLength: 3 }),
  fc.dictionary(fc.constantFrom("x", "y"), arbScalar, { maxKeys: 2 }),
);
const arbData = fc.dictionary(fc.constantFrom(...FIELD_POOL), arbValue, { maxKeys: 3 });

/**
 * Random event history over a shared pool of entity ids across models.
 * Every event gets a distinct seq, so ids are unique and seq order is ULID
 * order — fully deterministic from the fast-check run. Timestamps are
 * decoupled from ids (small colliding tsSeed pool, G2) so id-vs-ts ordering
 * bugs cannot hide behind aligned clocks.
 */
const arbEvents: fc.Arbitrary<KanonEvent[]> = fc
  .array(
    fc.record({
      op: fc.constantFrom(...OP_POOL),
      model: fc.constantFrom(...MODEL_POOL),
      entity: fc.integer({ min: 0, max: 5 }),
      data: arbData,
      tsSeed: fc.integer({ min: 0, max: 15 }),
    }),
    { minLength: 1, maxLength: 40 },
  )
  .map((specs) => specs.map((spec, i) => makeEvent({ seq: i + 1, ...spec })));

describe("replay properties", () => {
  test("PROPERTY: convergence — every partition/permutation of the union replays to the same checksum", () => {
    const arb = arbEvents.chain((events) =>
      fc.record({
        events: fc.constant(events),
        shuffled: fc.shuffledSubarray(events, {
          minLength: events.length,
          maxLength: events.length,
        }),
        cuts: fc.array(fc.integer({ min: 0, max: events.length }), {
          minLength: 1,
          maxLength: 3,
        }),
        overlap: fc.integer({ min: 0, max: events.length }),
      }),
    );
    fc.assert(
      fc.property(arb, ({ events, shuffled, cuts, overlap }) => {
        const baseline = stateChecksum(replayMerged(events));
        // K in {2..4} clones: a random permutation of the union, split at
        // random cut points — each clone saw a different slice of history.
        const clones: KanonEvent[][] = [];
        let prev = 0;
        for (const cut of [...cuts].sort((a, b) => a - b)) {
          clones.push(shuffled.slice(prev, cut));
          prev = cut;
        }
        clones.push(shuffled.slice(prev));
        // Replicas that already synced share events — overlap must not matter.
        clones.push(shuffled.slice(0, overlap));
        expect(stateChecksum(replayMerged(...clones))).toBe(baseline);
      }),
      { numRuns: 250 },
    );
  });

  test("PROPERTY: idempotence — duplicated streams and re-application change nothing", () => {
    fc.assert(
      fc.property(arbEvents, (events) => {
        const once = stateChecksum(replayMerged(events));
        expect(stateChecksum(replayMerged(events, events))).toBe(once);

        const sorted = unionMerge(events);
        const state = replay(sorted);
        const before = stateChecksum(state);
        replay(sorted, state);
        expect(stateChecksum(state)).toBe(before);
      }),
      { numRuns: 200 },
    );
  });

  test("PROPERTY: wire round-trip — JSONL serialize/parse preserves the replay checksum (G3)", () => {
    fc.assert(
      fc.property(arbEvents, (events) => {
        const sorted = unionMerge(events);
        const wire = sorted.map((event) => parseEventLine(serializeEvent(event)));
        expect(stateChecksum(replay(wire))).toBe(stateChecksum(replay(sorted)));
      }),
      { numRuns: 200 },
    );
  });

  test("PROPERTY: incremental resume — pure suffixes and matching prefixes succeed; grown/changed prefixes throw (G4)", () => {
    const arb = arbEvents.chain((events) =>
      fc.record({
        events: fc.constant(events),
        mask: fc.array(fc.boolean(), { minLength: events.length, maxLength: events.length }),
        // Byzantine growth: same-id occurrences with independent content/ts
        // that may displace canonical content via the merge tie-break.
        dupes: fc.array(
          fc.record({
            index: fc.nat(),
            title: fc.string({ maxLength: 5 }),
            tsSeed: fc.integer({ min: 0, max: 15 }),
          }),
          { maxLength: 4 },
        ),
      }),
    );
    fc.assert(
      fc.property(arb, ({ events, mask, dupes }) => {
        const sorted = unionMerge(events);

        // Pure suffix extension from a snapshot point always succeeds.
        const k = Math.floor(sorted.length / 2);
        const head = replay(sorted.slice(0, k));
        replay(sorted.slice(k), head);
        expect(stateChecksum(head)).toBe(stateChecksum(replay(sorted)));

        // Replica applied a random subset of the original history.
        const subset = sorted.filter((_, i) => mask[i] === true);
        if (subset.length === 0) {
          return;
        }
        const state = replay(subset);
        const cursor = subset[subset.length - 1]?.id ?? "";

        // The log then grows: new ids may appear anywhere AND conflicting
        // duplicates may displace canonical content for ids the replica
        // already applied.
        const variants = dupes.map((dupe): KanonEvent => {
          const at = dupe.index % sorted.length;
          const base = sorted[at];
          if (base === undefined) {
            throw new Error("unreachable: index is taken modulo sorted.length");
          }
          return { ...base, data: { title: dupe.title }, ts: testTs(dupe.tsSeed) };
        });
        const merged = unionMerge(sorted, variants);
        const baseline = stateChecksum(replay(merged));

        // Resume is sound iff the merged log's prefix at or below the
        // cursor is exactly the applied events — content included.
        const prefix = merged.filter((e) => e.id <= cursor);
        const soundResume =
          prefix.length === subset.length &&
          prefix.every((e, i) => stableStringify(e) === stableStringify(subset[i]));
        if (soundResume) {
          replay(merged, state);
          expect(stateChecksum(state)).toBe(baseline);
        } else {
          // Silent skipping would lose events or keep displaced content, so
          // replay must fail loudly.
          expect(() => replay(merged, state)).toThrow(ReplayDivergenceError);
        }
      }),
      { numRuns: 200 },
    );
  });

  test("PROPERTY: per-field LWW — higher event id wins regardless of arrival order; other fields survive", () => {
    const arb = fc.record({
      low: fc.string({ maxLength: 8 }),
      high: fc.string({ maxLength: 8 }),
      priority: fc.integer(),
      higherFirst: fc.boolean(),
      tsSeeds: fc.array(fc.integer({ min: 0, max: 15 }), { minLength: 3, maxLength: 3 }),
    });
    fc.assert(
      fc.property(arb, ({ low, high, priority, higherFirst, tsSeeds }) => {
        const create = makeEvent({
          seq: 1,
          op: "create",
          model: "issue",
          entity: 0,
          data: { title: "initial", state: "backlog" },
          tsSeed: tsSeeds[0] ?? 0,
        });
        // Two clones update concurrently: lower id writes title+state,
        // higher id writes title+priority.
        const lowUpdate = makeEvent({
          seq: 2,
          op: "update",
          model: "issue",
          entity: 0,
          data: { title: low, state: "started" },
          tsSeed: tsSeeds[1] ?? 0,
        });
        const highUpdate = makeEvent({
          seq: 3,
          op: "update",
          model: "issue",
          entity: 0,
          data: { title: high, priority },
          tsSeed: tsSeeds[2] ?? 0,
        });

        // Through the merge path, arrival order is the stream arrangement.
        const streams = higherFirst
          ? [[create], [highUpdate], [lowUpdate]]
          : [[create], [lowUpdate], [highUpdate]];
        const merged = replayMerged(...streams);
        const entity = mustGetEntity(merged, "issue", entityId(0));
        expect(entity.fields.title).toBe(high); // same field: higher id wins
        expect(entity.fields.state).toBe("started"); // different fields both survive
        expect(entity.fields.priority).toBe(priority);
        expect(merged.fieldVersions.get(fieldVersionKey("issue", entityId(0), "title"))).toBe(
          highUpdate.id,
        );

        // Raw applyEvent in both physical orders converges too — the LWW
        // guards, not input order, decide the winner.
        const forward = createWorldState();
        applyEvent(forward, create);
        applyEvent(forward, lowUpdate);
        applyEvent(forward, highUpdate);
        const reverse = createWorldState();
        applyEvent(reverse, create);
        applyEvent(reverse, highUpdate);
        applyEvent(reverse, lowUpdate);
        expect(mustGetEntity(reverse, "issue", entityId(0)).fields.title).toBe(high);
        expect(stateChecksum(reverse)).toBe(stateChecksum(forward));
      }),
      { numRuns: 200 },
    );
  });
});

describe("resume soundness (fix #1)", () => {
  test("REGRESSION: a log grown below the cursor throws instead of silently dropping events", () => {
    const e1 = makeEvent({ seq: 1, op: "create", model: "issue", entity: 0, data: { t: "a" } });
    const e5 = makeEvent({ seq: 5, op: "create", model: "issue", entity: 1, data: { t: "b" } });
    const state = replay([e5]);
    // The exact reviewer repro: merge later reveals e1 (id < cursor).
    expect(() => replay(unionMerge([e1, e5]), state)).toThrow(ReplayDivergenceError);
    // A stream that is neither a pure suffix nor the applied history fails
    // even when it ends below the cursor.
    expect(() => replay([e1], state)).toThrow(ReplayDivergenceError);
    // The failed resume did not corrupt the state: e5 alone is still applied.
    expect(state.appliedCount).toBe(1);
    expect(stateChecksum(state)).toBe(stateChecksum(replay([e5])));
  });

  test("resume with the full unchanged log verifies the prefix and applies only the suffix", () => {
    const events = [
      makeEvent({ seq: 1, op: "create", model: "issue", entity: 0, data: { title: "one" } }),
      makeEvent({ seq: 2, op: "update", model: "issue", entity: 0, data: { title: "two" } }),
      makeEvent({ seq: 3, op: "update", model: "issue", entity: 0, data: { state: "done" } }),
    ];
    const state = replay(events.slice(0, 2));
    expect(state.cursor).toBe(events[1]?.id ?? "");
    replay(events, state); // prefix matches the fingerprint; only seq 3 applies
    const entity = mustGetEntity(state, "issue", entityId(0));
    expect(entity.fields).toEqual({ title: "two", state: "done" });
    expect(state.cursor).toBe(events[2]?.id ?? "");
    expect(state.appliedCount).toBe(3);
  });

  test("unsorted or duplicated input throws ReplayOrderError instead of skipping (fix #6)", () => {
    const e1 = makeEvent({ seq: 1, op: "create", model: "issue", entity: 0, data: {} });
    const e2 = makeEvent({ seq: 2, op: "update", model: "issue", entity: 0, data: { t: 1 } });
    expect(() => replay([e2, e1])).toThrow(ReplayOrderError); // fresh, out of order
    expect(() => replay([e1, e1])).toThrow(ReplayOrderError); // fresh, duplicate
    const state = replay([e1]);
    expect(() => replay([e2, e2], state)).toThrow(ReplayOrderError); // resumed, duplicate
  });

  test("REGRESSION: a below-cursor duplicate whose content became canonical is caught on resume (round-2 #1)", () => {
    // Reviewer repro: replica applied the tie-break LOSER ("zzz"); the
    // merged log's canonical occurrence is the winner ("aaa"). Ids are
    // identical, so an id-only fingerprint would pass verification and the
    // replica would silently keep "zzz" while fresh rebuilds hold "aaa".
    const winner = makeEvent({
      seq: 1,
      op: "create",
      model: "issue",
      entity: 0,
      data: { title: "aaa" },
    });
    const loser = makeEvent({
      seq: 1,
      op: "create",
      model: "issue",
      entity: 0,
      data: { title: "zzz" },
    });
    const merged = unionMerge([winner], [loser]);
    expect(merged).toEqual([winner]); // tie-break kept the canonical content

    const replica = replay([loser]); // this replica applied the displaced content
    expect(() => replay(merged, replica)).toThrow(ReplayDivergenceError);

    // Fresh rebuilds converge on the canonical content.
    const rebuilt = replay(merged);
    expect(mustGetEntity(rebuilt, "issue", entityId(0)).fields.title).toBe("aaa");
    expect(stateChecksum(rebuilt)).not.toBe(stateChecksum(replica));
  });

  test("a raw-applyEvent state (applied events, no cursor) is rejected with ReplayStateError (round-2 #2)", () => {
    const e1 = makeEvent({ seq: 1, op: "create", model: "issue", entity: 0, data: {} });
    const e2 = makeEvent({ seq: 2, op: "update", model: "issue", entity: 0, data: { t: 1 } });
    const rawState = createWorldState();
    applyEvent(rawState, e1); // appliedCount > 0, cursor still null
    expect(() => replay([e2], rawState)).toThrow(ReplayStateError);
    // A fresh empty state is fine — the guard targets raw-applyEvent mixes only.
    expect(() => replay([e1, e2])).not.toThrow();
  });
});

describe("tombstones and resurrection", () => {
  test("delete tombstones: entity retained with fields, deleted=true", () => {
    const state = replayMerged([
      makeEvent({ seq: 1, op: "create", model: "issue", entity: 0, data: { title: "keep me" } }),
      makeEvent({ seq: 2, op: "delete", model: "issue", entity: 0 }),
    ]);
    const entity = mustGetEntity(state, "issue", entityId(0));
    expect(entity.deleted).toBe(true);
    expect(entity.fields).toEqual({ title: "keep me" }); // retained, not erased
    expect(state.fieldVersions.get(fieldVersionKey("issue", entityId(0), DELETED_FIELD))).toBe(
      makeEvent({ seq: 2, op: "delete", model: "issue", entity: 0 }).id,
    );
  });

  test("a later create resurrects a tombstoned entity", () => {
    const state = replayMerged([
      makeEvent({ seq: 1, op: "create", model: "issue", entity: 0, data: { title: "v1" } }),
      makeEvent({ seq: 2, op: "delete", model: "issue", entity: 0 }),
      makeEvent({ seq: 3, op: "create", model: "issue", entity: 0, data: { title: "v2" } }),
    ]);
    const entity = mustGetEntity(state, "issue", entityId(0));
    expect(entity.deleted).toBe(false);
    expect(entity.fields.title).toBe("v2");
  });

  test("an earlier-id create does NOT resurrect a later-id delete (LWW)", () => {
    // Applied out of physical order via applyEvent: delete (seq 3) lands
    // first, then a create with a lower id — the delete's register wins.
    const state = createWorldState();
    applyEvent(state, makeEvent({ seq: 3, op: "delete", model: "issue", entity: 0 }));
    applyEvent(
      state,
      makeEvent({ seq: 1, op: "create", model: "issue", entity: 0, data: { title: "old" } }),
    );
    const entity = mustGetEntity(state, "issue", entityId(0));
    expect(entity.deleted).toBe(true);
    expect(entity.fields.title).toBe("old"); // field LWW is independent of the tombstone
  });

  test("update never resurrects — fields mutate, tombstone stays", () => {
    const state = replayMerged([
      makeEvent({ seq: 1, op: "create", model: "issue", entity: 0, data: { title: "v1" } }),
      makeEvent({ seq: 2, op: "delete", model: "issue", entity: 0 }),
      makeEvent({ seq: 3, op: "update", model: "issue", entity: 0, data: { title: "late" } }),
    ]);
    const entity = mustGetEntity(state, "issue", entityId(0));
    expect(entity.deleted).toBe(true);
    expect(entity.fields.title).toBe("late");
  });
});

describe("archive / unarchive", () => {
  test("archive stamps archivedAt with the event ts; unarchive clears it", () => {
    const archiveEvent = makeEvent({ seq: 2, op: "archive", model: "issue", entity: 0 });
    const archived = replayMerged([
      makeEvent({ seq: 1, op: "create", model: "issue", entity: 0, data: {} }),
      archiveEvent,
    ]);
    expect(mustGetEntity(archived, "issue", entityId(0)).archivedAt).toBe(archiveEvent.ts);

    const unarchived = replayMerged([
      makeEvent({ seq: 1, op: "create", model: "issue", entity: 0, data: {} }),
      archiveEvent,
      makeEvent({ seq: 3, op: "unarchive", model: "issue", entity: 0 }),
    ]);
    expect(mustGetEntity(unarchived, "issue", entityId(0)).archivedAt).toBeNull();
  });

  test("archive state is LWW: a later-id unarchive beats an earlier-id archive in any order", () => {
    const state = createWorldState();
    applyEvent(state, makeEvent({ seq: 1, op: "create", model: "issue", entity: 0, data: {} }));
    applyEvent(state, makeEvent({ seq: 3, op: "unarchive", model: "issue", entity: 0 }));
    applyEvent(state, makeEvent({ seq: 2, op: "archive", model: "issue", entity: 0 }));
    expect(mustGetEntity(state, "issue", entityId(0)).archivedAt).toBeNull();
  });
});

describe("relations (relate / unrelate)", () => {
  const relationData = {
    type: "blocks",
    issueId: entityId(1),
    relatedIssueId: entityId(2),
  };

  test("relate materializes an issue_relation entity; unrelate tombstones it", () => {
    const state = replayMerged([
      makeEvent({ seq: 1, op: "relate", model: "issue_relation", entity: 9, data: relationData }),
    ]);
    const relation = mustGetEntity(state, "issue_relation", entityId(9));
    expect(relation.deleted).toBe(false);
    expect(relation.fields).toEqual(relationData);

    const removed = replayMerged([
      makeEvent({ seq: 1, op: "relate", model: "issue_relation", entity: 9, data: relationData }),
      makeEvent({ seq: 2, op: "unrelate", model: "issue_relation", entity: 9 }),
    ]);
    expect(mustGetEntity(removed, "issue_relation", entityId(9)).deleted).toBe(true);
  });

  test("a later relate resurrects the relation (create semantics)", () => {
    const state = replayMerged([
      makeEvent({ seq: 1, op: "relate", model: "issue_relation", entity: 9, data: relationData }),
      makeEvent({ seq: 2, op: "unrelate", model: "issue_relation", entity: 9 }),
      makeEvent({ seq: 3, op: "relate", model: "issue_relation", entity: 9, data: relationData }),
    ]);
    expect(mustGetEntity(state, "issue_relation", entityId(9)).deleted).toBe(false);
  });
});

describe("replay mechanics", () => {
  test("createdAt is LWW-MIN: the smallest introducing event id wins in any order (fix #5)", () => {
    // ts is deliberately inverted relative to id order: the earlier-id event
    // carries the LATER wall-clock ts, proving the register keys on id.
    const early = makeEvent({ seq: 1, op: "create", model: "issue", entity: 0, tsSeed: 9 });
    const late = makeEvent({ seq: 2, op: "update", model: "issue", entity: 0, tsSeed: 1 });
    const forward = createWorldState();
    applyEvent(forward, early);
    applyEvent(forward, late);
    const reverse = createWorldState();
    applyEvent(reverse, late);
    applyEvent(reverse, early);
    expect(mustGetEntity(forward, "issue", entityId(0)).createdAt).toBe(early.ts);
    expect(mustGetEntity(reverse, "issue", entityId(0)).createdAt).toBe(early.ts);
    expect(stateChecksum(reverse)).toBe(stateChecksum(forward));
  });

  test("entities referenced before their create still materialize (partial history)", () => {
    const update = makeEvent({
      seq: 5,
      op: "update",
      model: "issue",
      entity: 3,
      data: { title: "orphan" },
    });
    const state = replayMerged([update]);
    const entity = mustGetEntity(state, "issue", entityId(3));
    expect(entity.fields.title).toBe("orphan");
    expect(entity.createdAt).toBe(update.ts);
    expect(entity.lastEventId).toBe(update.id);
  });

  test("same entity id under different models are distinct entities", () => {
    const state = replayMerged([
      makeEvent({ seq: 1, op: "create", model: "issue", entity: 0, data: { title: "issue" } }),
      makeEvent({ seq: 2, op: "create", model: "project", entity: 0, data: { title: "project" } }),
    ]);
    expect(mustGetEntity(state, "issue", entityId(0)).fields.title).toBe("issue");
    expect(mustGetEntity(state, "project", entityId(0)).fields.title).toBe("project");
  });

  test("reserved __-prefixed data fields are ignored, not materialized", () => {
    const state = replayMerged([
      makeEvent({
        seq: 1,
        op: "create",
        model: "issue",
        entity: 0,
        data: { title: "real", __deleted: true, __archived: "bogus", __created: "bogus" },
      }),
    ]);
    const entity = mustGetEntity(state, "issue", entityId(0));
    expect(entity.deleted).toBe(false);
    expect(entity.archivedAt).toBeNull();
    expect(entity.fields).toEqual({ title: "real" });
  });
});
