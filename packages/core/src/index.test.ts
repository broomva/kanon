import { describe, expect, test } from "bun:test";
import schema from "../schema/event.schema.json";
import {
  createEvent,
  parseEventLine,
  segmentName,
  serializeEvent,
  ULID_PATTERN,
  ulid,
  validateEvent,
} from "./index";

const actor = { type: "agent", id: "claude-fable-5", surface: "cli" } as const;

describe("ulid", () => {
  test("shape: 26 chars of Crockford base32", () => {
    for (let i = 0; i < 100; i++) {
      expect(ulid()).toMatch(ULID_PATTERN);
    }
  });

  test("monotonic within the same millisecond", () => {
    const now = Date.now();
    const ids = Array.from({ length: 500 }, () => ulid(now));
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("time-ordered across milliseconds", () => {
    const earlier = ulid(1_000_000_000_000);
    const later = ulid(2_000_000_000_000);
    expect(earlier < later).toBe(true);
  });
});

describe("createEvent / validateEvent", () => {
  test("round-trips through JSONL serialization", () => {
    const event = createEvent({
      workspace: "broomva",
      actor,
      op: "create",
      model: "issue",
      data: { title: "First issue", state: "backlog" },
    });
    const line = serializeEvent(event);
    expect(parseEventLine(line)).toEqual(event);
  });

  test("rejects unknown op and model", () => {
    const event = createEvent({
      workspace: "broomva",
      actor,
      op: "update",
      model: "issue",
      data: {},
    });
    expect(validateEvent({ ...event, op: "destroy" }).ok).toBe(false);
    expect(validateEvent({ ...event, model: "ticket" }).ok).toBe(false);
  });

  test("rejects missing attribution", () => {
    const event = createEvent({
      workspace: "broomva",
      actor,
      op: "update",
      model: "issue",
      data: {},
    });
    const { actor: _dropped, ...withoutActor } = event;
    expect(validateEvent(withoutActor).ok).toBe(false);
    expect(validateEvent({ ...event, actor: { ...actor, id: "" } }).ok).toBe(false);
  });

  test("rejects bad workspace slugs and non-ULID keys", () => {
    expect(() =>
      createEvent({ workspace: "Broomva!", actor, op: "create", model: "issue", data: {} }),
    ).toThrow();
    const event = createEvent({
      workspace: "broomva",
      actor,
      op: "create",
      model: "issue",
      data: {},
    });
    expect(validateEvent({ ...event, modelId: "BRO-1234" }).ok).toBe(false);
  });
});

describe("data JSON-safety", () => {
  const base = () =>
    createEvent({ workspace: "broomva", actor, op: "update", model: "issue", data: {} });

  test("rejects values that would diverge from their JSONL wire form", () => {
    const event = base();
    expect(validateEvent({ ...event, data: { a: undefined } }).ok).toBe(false);
    expect(validateEvent({ ...event, data: { a: Number.NaN } }).ok).toBe(false);
    expect(validateEvent({ ...event, data: { a: Number.POSITIVE_INFINITY } }).ok).toBe(false);
    expect(validateEvent({ ...event, data: { a: 1n } }).ok).toBe(false);
    expect(validateEvent({ ...event, data: { a: new Date() } }).ok).toBe(false);
    expect(validateEvent({ ...event, data: { a: () => 1 } }).ok).toBe(false);
    // ...at any depth, including inside arrays and nested objects.
    expect(validateEvent({ ...event, data: { a: [undefined] } }).ok).toBe(false);
    expect(validateEvent({ ...event, data: { a: { b: new Map() } } }).ok).toBe(false);
    expect(validateEvent({ ...event, data: { a: [{ b: Number.NaN }] } }).ok).toBe(false);
    // ...and the data object itself must be plain.
    expect(validateEvent({ ...event, data: new Date() }).ok).toBe(false);
  });

  test("accepts nested plain JSON", () => {
    const event = base();
    const data = {
      title: "ok",
      estimate: 0.5,
      done: false,
      labels: ["a", "b", null],
      nested: { deep: { list: [1, 2, { x: true }] } },
    };
    expect(validateEvent({ ...event, data }).ok).toBe(true);
    // null-prototype objects are plain JSON carriers too.
    const nullProto = Object.create(null) as Record<string, unknown>;
    nullProto.a = 1;
    expect(validateEvent({ ...event, data: { holder: nullProto } }).ok).toBe(true);
  });
});

describe("schema agreement", () => {
  test("hand validator enforces every schema-required field", () => {
    const required = schema.required as string[];
    const event = createEvent({
      workspace: "broomva",
      actor,
      op: "create",
      model: "issue",
      data: {},
    });
    for (const field of required) {
      const clone: Record<string, unknown> = { ...event };
      delete clone[field];
      expect(validateEvent(clone).ok).toBe(false);
    }
  });

  test("enums match the schema", () => {
    const props = schema.properties as Record<string, { enum?: string[] }>;
    const event = createEvent({
      workspace: "broomva",
      actor,
      op: "create",
      model: "issue",
      data: {},
    });
    for (const op of props.op?.enum ?? []) {
      expect(validateEvent({ ...event, op }).ok).toBe(true);
    }
    for (const model of props.model?.enum ?? []) {
      expect(validateEvent({ ...event, model }).ok).toBe(true);
    }
  });
});

describe("segmentName", () => {
  test("groups by UTC month", () => {
    expect(segmentName("2026-07-01T22:14:03.201Z")).toBe("2026-07.jsonl");
  });
});
