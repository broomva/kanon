/**
 * Kanon extension tools — the agent-session/activity platform (M3 Phase 2,
 * BRO-1649). These are NOT part of the linear-server parity oracle: Linear's
 * MCP has no session tools (its agent sessions live in the GraphQL API), so
 * Kanon advertises them alongside the ported Linear surface. `parity.test.ts`
 * pins the Linear subset against the oracle and asserts these never collide
 * with an oracle tool name.
 *
 * Session state is derived — it moves only via activity appends and the
 * server-side stale janitor. There is deliberately no "set state" tool.
 */

import { AGENT_ACTIVITY_TYPES, AGENT_SESSION_STATES } from "@kanon/core";
import type { ToolSchema } from "./linear-schemas";

const str = (description: string) => ({ type: "string", description });

export const KANON_TOOL_SCHEMAS: Record<string, ToolSchema> = {
  create_agent_session: {
    description:
      "Delegate an issue to an agent: creates an agent session (state `pending`) bound to the " +
      "issue, re-points the issue's delegate seat at the agent, and optionally records the " +
      "delegation brief as the first `prompt` activity. Omit `agent` to open the session for " +
      "the calling actor.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["issue"],
      properties: {
        issue: str("Issue ID or identifier (e.g., BRO-123)"),
        agent: str("Agent actor: ULID, name, or email. Defaults to the calling actor"),
        prompt: str("Delegation brief, recorded as the session's first `prompt` activity"),
      },
    },
  },
  list_agent_sessions: {
    description:
      "List agent sessions, optionally filtered by issue, agent actor, or lifecycle state " +
      `(${AGENT_SESSION_STATES.join(", ")}).`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        issue: str("Issue ID or identifier (e.g., BRO-123)"),
        agent: str("Agent actor: ULID, name, or email"),
        state: {
          type: "string",
          enum: [...AGENT_SESSION_STATES],
          description: "Lifecycle state filter",
        },
      },
    },
  },
  get_agent_session: {
    description:
      "Retrieve one agent session with its issue and the full activity timeline " +
      "(prompts, thoughts, actions, elicitations, responses, errors) in order.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: { id: str("Agent session ID (ULID)") },
    },
  },
  append_agent_activity: {
    description:
      "Append an activity to an agent session's timeline. The session state moves with the " +
      "activity type: thought/action → active, elicitation → awaitingInput, prompt (an " +
      "elicitation answer or follow-up) → active, response → complete, error → error.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["sessionId", "type", "body"],
      properties: {
        sessionId: str("Agent session ID (ULID)"),
        type: {
          type: "string",
          enum: [...AGENT_ACTIVITY_TYPES],
          description:
            "Activity type: `prompt` is inbound (delegator → agent); thought/action/" +
            "elicitation/response/error are the agent's outbound turn",
        },
        body: str("Activity content as Markdown"),
      },
    },
  },
  get_cycle: {
    description:
      "Retrieve one cycle by ID (Kanon extension — Linear's MCP has no get_cycle; list_cycles " +
      "returns a team's cycles, this fetches a single one with its dates + description).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: { id: str("Cycle ID (ULID)") },
    },
  },
  save_cycle: {
    description:
      "Create or update a cycle (Kanon extension — Linear's MCP exposes cycles read-only via " +
      "list_cycles). If `id` is provided, updates the existing cycle; otherwise creates a new " +
      "one. When creating, `team` is required.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: str("Cycle ID (ULID). If provided, updates the existing cycle"),
        team: str("Team name or ID (required when creating)"),
        name: str("Cycle name"),
        number: { type: "integer", minimum: 0, description: "Cycle number" },
        startsAt: str("Start date (ISO format)"),
        endsAt: str("End date (ISO format)"),
        description: str("Content as Markdown"),
      },
    },
  },
  list_views: {
    description:
      "List saved views — named, reusable issue-list filters (Kanon-native; Linear's MCP has no " +
      "view tools). Re-run one by reading its filter and passing it to list_issues.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  get_view: {
    description: "Retrieve one saved view by name or ID, showing its stored issue-list filter.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: { query: str("Saved view name or ID") },
    },
  },
  save_view: {
    description:
      "Create or update a saved view — a named, reusable issue-list filter " +
      "(team/state/assignee/project/label/priority/query). If `id` is provided, updates the " +
      "existing view; otherwise creates a new one. When creating, `name` is required and unique.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: str("Saved view ID (ULID). If provided, updates the existing view"),
        name: str("View name (required when creating; must be unique)"),
        description: str("What the view is for"),
        team: str("Team filter: key, name, or ID"),
        state: str("State filter: type or name"),
        assignee: str('Assignee filter: ULID, name, email, or "me"'),
        project: str("Project filter: name, ID, or slug"),
        label: str("Label filter: name or ID"),
        priority: {
          type: "integer",
          minimum: 0,
          maximum: 4,
          description: "Priority filter: 0=None, 1=Urgent, 2=High, 3=Medium, 4=Low",
        },
        query: str("Text search filter"),
      },
    },
  },
};

export type KanonToolName = keyof typeof KANON_TOOL_SCHEMAS;
