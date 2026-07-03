/**
 * @kanon/core — the event model.
 *
 * The append-only event log is canonical; every store (SQLite, Postgres, UI)
 * is a rebuildable projection. Events are JSONL lines in monthly segments
 * inside a per-workspace git data-repo. The language-neutral contract lives
 * in schema/event.schema.json; this module is its TypeScript implementation.
 */

export const SCHEMA_VERSION = 1 as const;

export const ACTOR_TYPES = ["human", "agent", "app", "system"] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export const SURFACES = ["cli", "http", "mcp", "ui", "import", "system"] as const;
export type Surface = (typeof SURFACES)[number];

export const OPS = [
  "create",
  "update",
  "archive",
  "unarchive",
  "delete",
  "relate",
  "unrelate",
] as const;
export type Op = (typeof OPS)[number];

export const MODELS = [
  "workspace",
  "team",
  "actor",
  "workflow_state",
  "issue",
  "label",
  "issue_relation",
  "project",
  "milestone",
  "initiative",
  "status_update",
  "document",
  "cycle",
  "comment",
  "agent_session",
  "agent_activity",
  "api_key",
  "webhook",
] as const;
export type Model = (typeof MODELS)[number];

/**
 * Agent-session lifecycle (Linear-parity vocabulary). State is DERIVED —
 * it moves only via activity appends and the stale janitor, never set
 * directly: pending → active → error/awaitingInput → complete → stale.
 */
export const AGENT_SESSION_STATES = [
  "pending",
  "active",
  "error",
  "awaitingInput",
  "complete",
  "stale",
] as const;
export type AgentSessionState = (typeof AGENT_SESSION_STATES)[number];

/**
 * Agent-activity stream vocabulary (Linear-parity). `prompt` is the inbound
 * direction (user/delegator → agent: the delegation brief or an elicitation
 * answer); the rest are the agent's outbound turn.
 */
export const AGENT_ACTIVITY_TYPES = [
  "prompt",
  "thought",
  "action",
  "elicitation",
  "response",
  "error",
] as const;
export type AgentActivityType = (typeof AGENT_ACTIVITY_TYPES)[number];

/**
 * The total session-state transition function: `state(after append)` given
 * the current state and the appended activity type. Total on purpose — the
 * log is distributed and append-only, so guards would fight replicas; LWW
 * converges whatever the interleaving.
 */
export function nextSessionState(
  current: AgentSessionState,
  activity: AgentActivityType,
): AgentSessionState {
  switch (activity) {
    case "prompt":
      // A prompt on a pending session is the delegation brief — the session
      // stays pending until the agent's first activity picks it up. On any
      // other state it (re)activates: answering an elicitation, reopening a
      // complete/stale/errored session with a follow-up.
      return current === "pending" ? "pending" : "active";
    case "thought":
    case "action":
      return "active";
    case "elicitation":
      return "awaitingInput";
    case "response":
      return "complete";
    case "error":
      return "error";
  }
}

export interface EventActor {
  type: ActorType;
  id: string;
  sessionId?: string;
  surface: Surface;
}

export interface KanonEvent {
  /** ULID — total order after union merge. */
  id: string;
  /** ISO-8601 UTC timestamp. */
  ts: string;
  /** Workspace slug; one git data-repo per workspace. */
  workspace: string;
  actor: EventActor;
  op: Op;
  model: Model;
  /** ULID entity key. Display identifiers (BRO-1234) are aliases, never keys. */
  modelId: string;
  data: Record<string, unknown>;
  v: typeof SCHEMA_VERSION;
}

// ---------------------------------------------------------------------------
// ULID — Crockford base32, monotonic within a process so events created in
// the same millisecond still sort in creation order.
// ---------------------------------------------------------------------------

const ULID_ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ULID_TIME_LEN = 10;
const ULID_RANDOM_LEN = 16;
export const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

let lastUlidTime = -1;
let lastUlidRandom: number[] = [];

function encodeTime(time: number): string {
  let out = "";
  let t = time;
  for (let i = 0; i < ULID_TIME_LEN; i++) {
    out = ULID_ENCODING[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function randomDigits(): number[] {
  const bytes = new Uint8Array(ULID_RANDOM_LEN);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b % 32);
}

export function ulid(now: number = Date.now()): string {
  if (now === lastUlidTime) {
    // Same millisecond: increment the random part to stay monotonic.
    for (let i = ULID_RANDOM_LEN - 1; i >= 0; i--) {
      const digit = lastUlidRandom[i] ?? 0;
      if (digit < 31) {
        lastUlidRandom[i] = digit + 1;
        break;
      }
      lastUlidRandom[i] = 0;
    }
  } else {
    lastUlidTime = now;
    lastUlidRandom = randomDigits();
  }
  const random = lastUlidRandom.map((d) => ULID_ENCODING[d]).join("");
  return encodeTime(now) + random;
}

// ---------------------------------------------------------------------------
// Validation — hand-rolled implementation of schema/event.schema.json.
// Zero-dep on purpose: the JSON Schema file is the interop contract, this
// function is the fast path. A fixture test keeps the two in agreement.
// ---------------------------------------------------------------------------

export const WORKSPACE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Deep JSON-safety check for event `data`. The in-memory event must equal
 * its JSONL wire form exactly, or replicas that read the log diverge from
 * the producer's in-memory state. Allowed: plain objects (prototype
 * Object.prototype or null), arrays, strings, finite numbers, booleans,
 * null. Rejected: undefined property values, NaN/Infinity, bigint,
 * functions, symbols, and non-plain objects (Date, Map, class instances —
 * anything JSON.stringify would coerce or drop).
 */
function validateJsonValue(value: unknown, path: string, errors: string[]): void {
  if (value === null) {
    return;
  }
  switch (typeof value) {
    case "string":
    case "boolean":
      return;
    case "number":
      if (!Number.isFinite(value)) {
        errors.push(`${path} must be a finite number (NaN/Infinity are not JSON)`);
      }
      return;
    case "undefined":
      errors.push(`${path} must not be undefined (JSON.stringify would drop or null it)`);
      return;
    case "object":
      break;
    default:
      // bigint, function, symbol
      errors.push(`${path} must be JSON-safe (found ${typeof value})`);
      return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      validateJsonValue(value[i], `${path}[${i}]`, errors);
    }
    return;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    errors.push(
      `${path} must be a plain JSON object (Dates, Maps, class instances are not wire-safe)`,
    );
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    validateJsonValue(entry, `${path}.${key}`, errors);
  }
}

export function validateEvent(value: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isPlainObject(value)) {
    return { ok: false, errors: ["event must be an object"] };
  }

  const { id, ts, workspace, actor, op, model, modelId, data, v } = value as Partial<KanonEvent>;

  if (typeof id !== "string" || !ULID_PATTERN.test(id)) {
    errors.push("id must be a 26-char Crockford-base32 ULID");
  }
  if (typeof ts !== "string" || Number.isNaN(Date.parse(ts))) {
    errors.push("ts must be an ISO-8601 timestamp");
  }
  if (typeof workspace !== "string" || !WORKSPACE_PATTERN.test(workspace)) {
    errors.push("workspace must be a lowercase slug (a-z, 0-9, -)");
  }
  if (!isPlainObject(actor)) {
    errors.push("actor must be an object");
  } else {
    if (!ACTOR_TYPES.includes(actor.type as ActorType)) {
      errors.push(`actor.type must be one of ${ACTOR_TYPES.join("|")}`);
    }
    if (typeof actor.id !== "string" || actor.id.length === 0) {
      errors.push("actor.id must be a non-empty string");
    }
    if (!SURFACES.includes(actor.surface as Surface)) {
      errors.push(`actor.surface must be one of ${SURFACES.join("|")}`);
    }
    if (
      actor.sessionId !== undefined &&
      (typeof actor.sessionId !== "string" || !actor.sessionId)
    ) {
      errors.push("actor.sessionId, when present, must be a non-empty string");
    }
  }
  if (!OPS.includes(op as Op)) {
    errors.push(`op must be one of ${OPS.join("|")}`);
  }
  if (!MODELS.includes(model as Model)) {
    errors.push(`model must be one of ${MODELS.join("|")}`);
  }
  if (typeof modelId !== "string" || !ULID_PATTERN.test(modelId)) {
    errors.push("modelId must be a 26-char Crockford-base32 ULID");
  }
  if (!isPlainObject(data)) {
    errors.push("data must be an object");
  } else {
    validateJsonValue(data, "data", errors);
  }
  if (v !== SCHEMA_VERSION) {
    errors.push(`v must be ${SCHEMA_VERSION}`);
  }

  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Construction + JSONL serialization
// ---------------------------------------------------------------------------

export interface CreateEventInput {
  workspace: string;
  actor: EventActor;
  op: Op;
  model: Model;
  modelId?: string;
  data: Record<string, unknown>;
  ts?: string;
  id?: string;
}

export function createEvent(input: CreateEventInput): KanonEvent {
  const event: KanonEvent = {
    id: input.id ?? ulid(),
    ts: input.ts ?? new Date().toISOString(),
    workspace: input.workspace,
    actor: input.actor,
    op: input.op,
    model: input.model,
    modelId: input.modelId ?? ulid(),
    data: input.data,
    v: SCHEMA_VERSION,
  };
  const result = validateEvent(event);
  if (!result.ok) {
    throw new Error(`invalid event: ${result.errors.join("; ")}`);
  }
  return event;
}

export function serializeEvent(event: KanonEvent): string {
  return JSON.stringify(event);
}

export function parseEventLine(line: string): KanonEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error(`event line is not valid JSON: ${line.slice(0, 80)}`);
  }
  const result = validateEvent(parsed);
  if (!result.ok) {
    throw new Error(`invalid event: ${result.errors.join("; ")}`);
  }
  return parsed as KanonEvent;
}

/** Segment file name for a timestamp: events are grouped by UTC month. */
export function segmentName(ts: string): string {
  return `${ts.slice(0, 7)}.jsonl`;
}

// ---------------------------------------------------------------------------
// M1 — merge, replay, snapshots (BRO-1644)
// ---------------------------------------------------------------------------

export * from "./merge";
export * from "./replay";
export * from "./snapshot";
export * from "./stable";
