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
};

export type KanonToolName = keyof typeof KANON_TOOL_SCHEMAS;
