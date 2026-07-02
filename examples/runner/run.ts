#!/usr/bin/env bun
/**
 * Reference Kanon runner — the standalone contract in ~80 lines.
 *
 * Polls GET /v1/sync/events from a cursor file. The full feed carries teams,
 * workflow states, and actors, so the runner derives everything it needs
 * from the log itself: when an issue create/update event has a `delegateId`
 * matching this runner's actor, OR a `stateId` transition to a started-type
 * state, it executes RUNNER_CMD with $KANON_ISSUE substituted (e.g.
 * `claude -p "work on issue $KANON_ISSUE"`). ANY daemon/CI/cron can
 * implement this loop — see README.md.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    console.error(`runner: ${name} is required`);
    process.exit(1);
  }
  return value;
}

const BASE = env("KANON_URL").replace(/\/$/, "");
const KEY = env("KANON_API_KEY");
const ACTOR = env("RUNNER_ACTOR", "runner");
const CMD = env("RUNNER_CMD");
const POLL_MS = Number(env("RUNNER_POLL_MS", "2000"));
const CURSOR_FILE = env("RUNNER_CURSOR_FILE", ".kanon-runner-cursor");

interface FeedEvent {
  id: string;
  op: string;
  model: string;
  modelId: string;
  data: Record<string, unknown>;
}

// Derived from the feed itself — no extra endpoints needed.
const teamKeys = new Map<string, string>(); // team id → key
const startedStates = new Set<string>(); // workflow_state ids with type "started"
const myActorIds = new Set<string>(); // actor ids whose name/email === ACTOR
const issues = new Map<string, { teamId?: string; number?: number }>();

let cursor = existsSync(CURSOR_FILE) ? readFileSync(CURSOR_FILE, "utf8").trim() : "";

function identifier(issueId: string): string {
  const issue = issues.get(issueId);
  const key = issue?.teamId === undefined ? undefined : teamKeys.get(issue.teamId);
  return key !== undefined && issue?.number !== undefined ? `${key}-${issue.number}` : issueId;
}

function track(event: FeedEvent): void {
  const { data } = event;
  if (event.model === "team" && typeof data.key === "string") {
    teamKeys.set(event.modelId, data.key);
  } else if (event.model === "workflow_state" && data.type === "started") {
    startedStates.add(event.modelId);
  } else if (event.model === "actor" && (data.name === ACTOR || data.email === ACTOR)) {
    myActorIds.add(event.modelId);
  } else if (event.model === "issue") {
    const issue = issues.get(event.modelId) ?? {};
    if (typeof data.teamId === "string") issue.teamId = data.teamId;
    if (typeof data.number === "number") issue.number = data.number;
    issues.set(event.modelId, issue);
  }
}

function shouldRun(event: FeedEvent): boolean {
  if (event.model !== "issue" || (event.op !== "create" && event.op !== "update")) return false;
  const delegated =
    typeof event.data.delegateId === "string" && myActorIds.has(event.data.delegateId);
  const started = typeof event.data.stateId === "string" && startedStates.has(event.data.stateId);
  return delegated || started;
}

async function poll(): Promise<void> {
  const after = cursor === "" ? "" : `&after=${cursor}`;
  const response = await fetch(`${BASE}/v1/sync/events?limit=500${after}`, {
    headers: { authorization: `Bearer ${KEY}` },
  });
  if (!response.ok) {
    console.error(`runner: feed returned HTTP ${response.status}`);
    return;
  }
  const page = (await response.json()) as { events: FeedEvent[]; hasMore: boolean };
  for (const event of page.events) {
    track(event);
    if (shouldRun(event)) {
      const issue = identifier(event.modelId);
      console.log(`runner: triggered by ${event.id} → ${issue}`);
      Bun.spawn(["/bin/sh", "-c", CMD], { env: { ...process.env, KANON_ISSUE: issue } });
    }
    cursor = event.id;
  }
  writeFileSync(CURSOR_FILE, cursor);
  if (page.hasMore) await poll();
}

console.log(`runner: actor "${ACTOR}" polling ${BASE} every ${POLL_MS}ms`);
for (;;) {
  await poll().catch((error: unknown) => {
    console.error(`runner: poll failed: ${error instanceof Error ? error.message : error}`);
  });
  await Bun.sleep(POLL_MS);
}
