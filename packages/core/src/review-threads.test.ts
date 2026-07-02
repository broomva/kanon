import { describe, expect, test } from "bun:test";
import { createEvent, ulid } from "./index";
import { replay } from "./replay";
import { restoreSnapshot, type SnapshotV1, takeSnapshot } from "./snapshot";
import { stableStringify } from "./stable";

const actor = { type: "agent", id: "test", surface: "cli" } as const;

describe("snapshot prototype-poisoning hardening (PR #1 review thread 1)", () => {
  test("crafted __proto__ field key in an untrusted snapshot cannot poison restored state", () => {
    const event = createEvent({
      workspace: "w",
      actor,
      op: "create",
      model: "issue",
      data: { title: "t" },
    });
    const clean = takeSnapshot(replay([event]));
    // JSON.parse creates "__proto__" as an OWN property — the untrusted path.
    const crafted = JSON.parse(
      JSON.stringify(clean).replace('"title":"t"', '"title":"t","__proto__":{"polluted":true}'),
    ) as SnapshotV1;

    const restored = restoreSnapshot(crafted);
    const entity = restored.entities.get("issue")?.get(event.modelId);
    expect(entity).toBeDefined();
    // The reserved-prefix filter drops the key entirely...
    expect(Object.keys(entity?.fields ?? {})).toEqual(["title"]);
    // ...and no prototype was polluted anywhere.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(entity?.fields)).toBe(Object.prototype);
    // Round-trip through snapshotEntity is also clean.
    const again = takeSnapshot(restored);
    expect(JSON.stringify(again)).not.toContain("polluted");
  });
});

describe("stableStringify identity strictness (PR #1 review thread 2)", () => {
  test("throws on bigint like JSON.stringify instead of silently dropping", () => {
    expect(() => stableStringify({ a: 1n })).toThrow(TypeError);
  });

  test("throws on non-plain objects instead of collapsing them to {}", () => {
    expect(() => stableStringify({ a: new Date() })).toThrow(TypeError);
    expect(() => stableStringify({ a: new Map([["k", "v"]]) })).toThrow(TypeError);
    expect(() => stableStringify(new Set([1]))).toThrow(TypeError);
    // Two distinct Dates must never compare content-equal via "{}".
    const d1 = { id: ulid(), payload: new Date(1) };
    const d2 = { id: d1.id, payload: new Date(2) };
    expect(() => stableStringify(d1)).toThrow(TypeError);
    expect(() => stableStringify(d2)).toThrow(TypeError);
  });

  test("still serializes plain nested JSON with sorted keys", () => {
    expect(stableStringify({ b: [1, { z: null, a: "x" }], a: true })).toBe(
      '{"a":true,"b":[1,{"a":"x","z":null}]}',
    );
    const nullProto = Object.create(null) as Record<string, unknown>;
    nullProto.k = 1;
    expect(stableStringify(nullProto)).toBe('{"k":1}');
  });
});

describe("malformed snapshot entities (PR #3 review thread)", () => {
  test("entity missing fields throws a typed malformed-snapshot error, not a bare TypeError", () => {
    const event = createEvent({
      workspace: "w",
      actor,
      op: "create",
      model: "issue",
      data: { title: "t" },
    });
    const clean = takeSnapshot(replay([event]));
    const crafted = JSON.parse(JSON.stringify(clean)) as SnapshotV1;
    // biome-ignore lint/performance/noDelete: crafting malformed input on purpose
    delete (Object.values(Object.values(crafted.entities)[0] ?? {})[0] as { fields?: unknown })
      .fields;
    expect(() => restoreSnapshot(crafted)).toThrow("malformed snapshot");
  });
});
