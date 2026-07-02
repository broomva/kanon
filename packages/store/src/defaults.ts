/**
 * Workspace defaults shared by every writer surface (CLI, rendezvous
 * server): the team-key charset and the default workflow-state set seeded on
 * `team create`.
 */

/** Identifier charset: keys become the TEAM half of TEAM-123, forever. */
export const TEAM_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/;

/**
 * The 7 default workflow states (Linear's canonical set) seeded when a team
 * is created: Triage/triage, Backlog/backlog, Todo/unstarted,
 * In Progress/started, Done/completed, Canceled/canceled, Duplicate/canceled.
 */
export const DEFAULT_STATES = [
  { name: "Triage", type: "triage", color: "#8a8f98", position: 0 },
  { name: "Backlog", type: "backlog", color: "#bec2c8", position: 1 },
  { name: "Todo", type: "unstarted", color: "#e2e2e2", position: 2 },
  { name: "In Progress", type: "started", color: "#f2c94c", position: 3 },
  { name: "Done", type: "completed", color: "#5e6ad2", position: 4 },
  { name: "Canceled", type: "canceled", color: "#95a2b3", position: 5 },
  { name: "Duplicate", type: "canceled", color: "#95a2b3", position: 6 },
] as const;
