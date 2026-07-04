// The typed client. Every call hits the same-origin proxy under /api/kanon,
// which forwards to the rendezvous server with the API key attached.

import type {
  AgentSessionDetail,
  AgentSessionRecord,
  Catalog,
  IssueDetail,
  IssueRecord,
} from "./types";

const ROOT = "/api/kanon/v1";

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${ROOT}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  const parsed = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const message =
      parsed && typeof parsed === "object" && "error" in parsed
        ? String((parsed as { error: unknown }).error)
        : `request failed (${res.status})`;
    throw new ApiError(res.status, message);
  }
  return parsed as T;
}

export function getCatalog(): Promise<Catalog> {
  return req<Catalog>("/catalog");
}

export interface IssueQuery {
  team?: string;
  state?: string;
  assignee?: string;
  delegate?: string;
  project?: string;
  label?: string;
  priority?: number;
  query?: string;
  limit?: number;
  orderBy?: "createdAt" | "updatedAt";
  orderDir?: "asc" | "desc";
}

export async function listIssues(query: IssueQuery = {}): Promise<IssueRecord[]> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  const q = params.toString();
  const res = await req<{ issues: IssueRecord[] }>(`/issues${q ? `?${q}` : ""}`);
  return res.issues;
}

export function getIssue(ref: string): Promise<IssueDetail> {
  return req<IssueDetail>(`/issues/${encodeURIComponent(ref)}`);
}

export interface CreateIssueInput {
  team: string;
  title: string;
  description?: string;
  priority?: number;
  assignee?: string;
  delegate?: string;
  project?: string;
  labels?: string[];
  state?: string;
}

export function createIssue(input: CreateIssueInput): Promise<{ issue: IssueRecord }> {
  return req<{ issue: IssueRecord }>("/issues", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export interface UpdateIssueInput {
  title?: string;
  description?: string | null;
  state?: string;
  priority?: number;
  assignee?: string | null;
  delegate?: string | null;
  project?: string | null;
  estimate?: number | null;
}

export function updateIssue(ref: string, patch: UpdateIssueInput): Promise<{ issue: IssueRecord }> {
  return req<{ issue: IssueRecord }>(`/issues/${encodeURIComponent(ref)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function addComment(ref: string, body: string): Promise<unknown> {
  return req(`/issues/${encodeURIComponent(ref)}/comments`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
}

export async function listAgentSessions(
  query: { issue?: string; state?: string } = {},
): Promise<AgentSessionRecord[]> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  const q = params.toString();
  const res = await req<{ sessions: AgentSessionRecord[] }>(`/agent-sessions${q ? `?${q}` : ""}`);
  return res.sessions;
}

export function getAgentSession(ref: string): Promise<AgentSessionDetail> {
  return req<AgentSessionDetail>(`/agent-sessions/${encodeURIComponent(ref)}`);
}
