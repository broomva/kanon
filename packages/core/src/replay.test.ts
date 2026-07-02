import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import type { KanonEvent, Model, Op } from "./index";
import { unionMerge } from "./merge";
import {
  applyEvent,
  createWorldState,
  DELETED_FIELD,
  fieldVersionKey,
  replay,
  replayMerged,
} from "./replay";
import { stateChecksum } from "./snapshot";
import { entityId, makeEvent, mustGetEntity } from "./testing";

const OP_POOL = ["create", "update", "archive", "unarchive", "delete"] as const satisfies Op[];
const MODEL_POOL = ["issue", "project", "label"] as const satisfies Model[];
const FIELD_POOL = ["title", "state", "priority", "estimate"] as const;

const arbValue = fc.oneof(
  fc.string({ maxLength: 8 }),
  fc.integer(),
  fc.boolean(),
  fc.constant(null),
);
const arbData = fc.dictionary(fc.constantFrom(...FIELD_POOL), arbValue, { maxKeys: 3 });

/**
 * Random event history over a shared pool of entity ids across models.
 * Every event gets a distinct seq, so ids are unique and seq order is ULID
 * order — fully deterministic from the fast-check run.
 */
const arbEvents: fc.Arbitrary<KanonEvent[]> = fc
  .array(
    fc.record({
      op: fc.constantFrom(...OP_POOL),
      model: fc.constantFrom(...MODEL_POOL),
      entity: fc.integer({ min: 0, max: 5 }),
      data: arbData,
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

  test("PROPERTY: per-field LWW — higher event id wins regardless of arrival order; other fields survive", () => {
    const arb = fc.record({
      low: fc.string({ maxLength: 8 }),
      high: fc.string({ maxLength: 8 }),
      priority: fc.integer(),
      higherFirst: fc.boolean(),
    });
    fc.assert(
      fc.property(arb, ({ low, high, priority, higherFirst }) => {
        const create = makeEvent({
          seq: 1,
          op: "create",
          model: "issue",
          entity: 0,
          data: { title: "initial", state: "backlog" },
        });
        // Two clones update concurrently: lower id writes title+state,
        // higher id writes title+priority.
        const lowUpdate = makeEvent({
          seq: 2,
          op: "update",
          model: "issue",
          entity: 0,
          data: { title: low, state: "started" },
        });
        const highUpdate = makeEvent({
          seq: 3,
          op: "update",
          model: "issue",
          entity: 0,
          data: { title: high, priority },
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
  test("skips events at or below the cursor (sorted-input contract)", () => {
    const events = [
      makeEvent({ seq: 1, op: "create", model: "issue", entity: 0, data: { title: "one" } }),
      makeEvent({ seq: 2, op: "update", model: "issue", entity: 0, data: { title: "two" } }),
      makeEvent({ seq: 3, op: "update", model: "issue", entity: 0, data: { state: "done" } }),
    ];
    const state = replay(events.slice(0, 2));
    expect(state.cursor).toBe(events[1]?.id ?? "");
    replay(events, state); // first two are <= cursor: skipped, not re-applied
    const entity = mustGetEntity(state, "issue", entityId(0));
    expect(entity.fields).toEqual({ title: "two", state: "done" });
    expect(state.cursor).toBe(events[2]?.id ?? "");
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
        data: { title: "real", __deleted: true, __archived: "bogus" },
      }),
    ]);
    const entity = mustGetEntity(state, "issue", entityId(0));
    expect(entity.deleted).toBe(false);
    expect(entity.archivedAt).toBeNull();
    expect(entity.fields).toEqual({ title: "real" });
  });
});
