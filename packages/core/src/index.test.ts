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
