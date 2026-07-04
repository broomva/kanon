"use client";

import { GitBranch, MessageSquare, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { addComment, getAgentSession, getIssue, listAgentSessions, updateIssue } from "../lib/api";
import type { CatalogIndex } from "../lib/catalog";
import { relationVerb, relativeTime } from "../lib/format";
import { glassComposerBlur } from "../lib/glass";
import type { AgentActivityRecord, AgentSessionRecord, IssueDetail as Detail } from "../lib/types";
import { bucketMeta, bucketOf, priorityMeta } from "../lib/work-state";
import { Avatar, Badge, ToneDot } from "./primitives";

const RAIL: { id: string; label: string }[] = [
  { id: "queued", label: "Queued" },
  { id: "started", label: "In progress" },
  { id: "done", label: "Done" },
];

interface SessionWithActivities extends AgentSessionRecord {
  activities: AgentActivityRecord[];
}

export interface IssueDetailProps {
  issueRef: string;
  cat: CatalogIndex;
  refreshKey: number;
  live: boolean;
  onClose: () => void;
  onChanged: () => void;
}

export function IssueDetail({
  issueRef,
  cat,
  refreshKey,
  live,
  onClose,
  onChanged,
}: IssueDetailProps) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [sessions, setSessions] = useState<SessionWithActivities[]>([]);
  const [tab, setTab] = useState<"activity" | "comments">("activity");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await getIssue(issueRef);
      setDetail(d);
      setError(null);
      const list = await listAgentSessions({ issue: d.issue.id });
      const withActivities = await Promise.all(
        list.map(async (s) => {
          try {
            const sd = await getAgentSession(s.id);
            return { ...s, activities: sd.activities };
          } catch {
            return { ...s, activities: [] as AgentActivityRecord[] };
          }
        }),
      );
      setSessions(withActivities);
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not load this work");
    }
  }, [issueRef]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is a live-event tick that forces a refetch
  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  if (error && !detail) {
    return (
      <aside className="k-detail">
        <div className="k-detail-empty">
          <span className="k-empty-title">Couldn&apos;t open this</span>
          <span className="k-empty-sub">{error}</span>
        </div>
      </aside>
    );
  }
  if (!detail) {
    return (
      <aside className="k-detail">
        <div className="k-detail-empty">
          <span className="k-empty-sub">Loading…</span>
        </div>
      </aside>
    );
  }

  const { issue } = detail;
  const ref = issue.identifier ?? issue.id;
  const state = detail.state;
  const bucket = bucketMeta(bucketOf(state?.stateType));
  const railIdx = RAIL.findIndex((r) => r.id === bucket.id);
  const team = cat.team(issue.teamId);
  const project = cat.project(issue.projectId);
  const assignee = cat.actorName(issue.assigneeId);
  const delegate = cat.actorName(issue.delegateId);
  const prio = priorityMeta(issue.priority);
  const teamStates = cat.raw.states
    .filter((s) => s.teamId === issue.teamId)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

  async function changeState(stateId: string) {
    setBusy(true);
    try {
      await updateIssue(ref, { state: stateId });
      await load();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "state change failed");
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    const body = draft.trim();
    if (!body) return;
    setDraft("");
    setBusy(true);
    try {
      await addComment(ref, body);
      await load();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "comment failed");
      setDraft(body);
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="k-detail">
      <div className="k-detail-head">
        <div className="k-detail-crumbs">
          <span>{team?.name ?? team?.key ?? "Work"}</span>
          {project?.name ? <span className="k-crumb-sep">›</span> : null}
          {project?.name ? <span>{project.name}</span> : null}
          <span className="k-detail-spacer" />
          <button type="button" className="k-icon-btn" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="k-detail-titlerow">
          <span className="k-detail-ref">{ref}</span>
          <Badge bucket={bucket.id} label={live ? "Running" : bucket.label} live={live} />
        </div>
        <h1 className="k-detail-title">{issue.title ?? "Untitled"}</h1>

        <div className="k-facts">
          <label className="k-fact">
            <span className="k-fact-key">State</span>
            <select
              className="k-select"
              value={state?.id ?? ""}
              disabled={busy || teamStates.length === 0}
              onChange={(e) => changeState(e.target.value)}
            >
              {teamStates.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <div className="k-fact">
            <span className="k-fact-key">Priority</span>
            <span className="k-fact-val">
              <ToneDot tone={prio.tone} />
              {prio.label}
            </span>
          </div>
          {assignee ? (
            <div className="k-fact">
              <span className="k-fact-key">Assignee</span>
              <span className="k-fact-val">
                <Avatar name={assignee} size={18} />
                {assignee}
              </span>
            </div>
          ) : null}
          {delegate ? (
            <div className="k-fact">
              <span className="k-fact-key">Delegate</span>
              <span className="k-fact-val">
                <Avatar name={delegate} size={18} kind="agent" />
                {delegate}
              </span>
            </div>
          ) : null}
        </div>

        <div className="k-rail">
          {RAIL.map((stage, i) => (
            <span
              key={stage.id}
              className={`k-rail-stage${i < railIdx ? " is-passed" : i === railIdx ? " is-current" : ""}`}
            >
              <span className="k-rail-dot" />
              {stage.label}
            </span>
          ))}
          {bucket.id === "canceled" ? (
            <span className="k-rail-stage is-canceled">Canceled</span>
          ) : null}
        </div>

        <div className="k-tabs">
          <button
            type="button"
            className={`k-tab${tab === "activity" ? " is-active" : ""}`}
            onClick={() => setTab("activity")}
          >
            Activity
          </button>
          <button
            type="button"
            className={`k-tab${tab === "comments" ? " is-active" : ""}`}
            onClick={() => setTab("comments")}
          >
            Comments
            {detail.comments.length > 0 ? (
              <span className="k-tab-count">{detail.comments.length}</span>
            ) : null}
          </button>
        </div>
      </div>

      <div className="k-detail-body">
        {tab === "activity" ? (
          <>
            {issue.description ? (
              <div className="k-section">
                <div className="k-section-label">Description</div>
                <p className="k-desc">{issue.description}</p>
              </div>
            ) : null}

            {detail.relations.length > 0 ? (
              <div className="k-section">
                <div className="k-section-label">Relations</div>
                {detail.relations.map((rel) => {
                  const outgoing = rel.issueId === issue.id;
                  const other = outgoing ? rel.relatedIssueIdentifier : rel.issueIdentifier;
                  return (
                    <div key={rel.id} className="k-relation">
                      <span className="k-relation-verb">{relationVerb(rel.relType)}</span>
                      <span className="k-relation-ref">{other ?? "—"}</span>
                    </div>
                  );
                })}
              </div>
            ) : null}

            <div className="k-section">
              <div className="k-section-label">Agent sessions</div>
              {sessions.length === 0 ? (
                <div className="k-muted">No agent has picked this up yet.</div>
              ) : (
                sessions.map((s) => (
                  <div key={s.id} className="k-session">
                    <div className="k-session-head">
                      <Avatar name={cat.actorName(s.actorId) || "agent"} size={18} kind="agent" />
                      <span className="k-session-actor">{cat.actorName(s.actorId) || "agent"}</span>
                      <span className={`k-session-state k-session-state--${s.state ?? "pending"}`}>
                        {s.state ?? "pending"}
                      </span>
                      <span className="k-session-time">{relativeTime(s.updatedAt)}</span>
                    </div>
                    {s.activities.length > 0 ? (
                      <div className="k-timeline">
                        {s.activities.map((a) => (
                          <div key={a.id} className="k-tl-item">
                            <span className={`k-tl-glyph k-tl-glyph--${a.type ?? "thought"}`} />
                            <div className="k-tl-body">
                              <span className="k-tl-type">
                                {a.type ?? "note"}
                                <span className="k-tl-time">{relativeTime(a.createdAt)}</span>
                              </span>
                              {a.body ? <span className="k-tl-text">{a.body}</span> : null}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ))
              )}
            </div>

            <div className="k-receipt">
              <GitBranch size={13} />
              <span>
                {ref} · the log is the receipt — every change here is one attributed event
              </span>
            </div>
          </>
        ) : (
          <div className="k-comments">
            {detail.comments.length === 0 ? (
              <div className="k-muted">No comments yet.</div>
            ) : (
              detail.comments.map((c) => {
                const author = cat.actorName(c.actorId) || "someone";
                return (
                  <div key={c.id} className="k-comment">
                    <Avatar name={author} size={22} />
                    <div className="k-comment-body">
                      <span className="k-comment-head">
                        {author}
                        <span className="k-comment-time">{relativeTime(c.createdAt)}</span>
                      </span>
                      <p className="k-comment-text">{c.body}</p>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>

      {tab === "comments" ? (
        <div className="k-composer-wrap">
          <div className="bv-glass-composer k-composer" style={glassComposerBlur}>
            <MessageSquare size={16} className="k-composer-icon" />
            <textarea
              className="k-composer-input"
              placeholder="Add a comment…"
              value={draft}
              rows={1}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <button
              type="button"
              className="k-btn k-btn--primary k-btn--sm"
              disabled={busy || !draft.trim()}
              onClick={() => void send()}
            >
              Send
            </button>
          </div>
        </div>
      ) : null}
      {error ? <div className="k-detail-error">{error}</div> : null}
    </aside>
  );
}
