"use client";

import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { createIssue } from "../lib/api";
import type { CatalogIndex } from "../lib/catalog";
import { glassHeavyBlur } from "../lib/glass";
import { PRIORITIES } from "../lib/work-state";

export interface NewIssueDialogProps {
  open: boolean;
  cat: CatalogIndex;
  defaultTeamId?: string;
  defaultProjectId?: string;
  onClose: () => void;
  onCreated: (ref: string) => void;
}

export function NewIssueDialog({
  open,
  cat,
  defaultTeamId,
  defaultProjectId,
  onClose,
  onCreated,
}: NewIssueDialogProps) {
  const teams = cat.raw.teams;
  const [teamId, setTeamId] = useState(defaultTeamId ?? teams[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState(0);
  const [projectId, setProjectId] = useState(defaultProjectId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setTeamId(defaultTeamId ?? teams[0]?.id ?? "");
      setTitle("");
      setDescription("");
      setPriority(0);
      setProjectId(defaultProjectId ?? "");
      setError(null);
    }
  }, [open, defaultTeamId, defaultProjectId, teams]);

  if (!open) return null;

  async function submit() {
    const t = title.trim();
    if (!t || !teamId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await createIssue({
        team: teamId,
        title: t,
        description: description.trim() || undefined,
        priority,
        project: projectId || undefined,
      });
      const ref = res.issue.identifier ?? res.issue.id;
      onCreated(ref);
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not create the issue");
    } finally {
      setBusy(false);
    }
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: click-outside backdrop; Esc + close button are the accessible paths
    <div className="k-cmd-scrim bv-scrim" onMouseDown={onClose}>
      <div
        className="k-dialog bv-glass-heavy"
        style={glassHeavyBlur}
        role="dialog"
        aria-modal="true"
        aria-label="New work"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void submit();
        }}
      >
        <div className="k-dialog-head">
          <span className="k-dialog-title">New work</span>
          <button type="button" className="k-icon-btn" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className="k-dialog-body">
          <input
            className="k-input k-input--title"
            placeholder="What needs doing?"
            value={title}
            // biome-ignore lint/a11y/noAutofocus: primary field of an intentional dialog
            autoFocus
            onChange={(e) => setTitle(e.target.value)}
          />
          <textarea
            className="k-input k-textarea"
            placeholder="Add detail, links, acceptance…"
            rows={4}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <div className="k-dialog-row">
            <label className="k-field">
              <span className="k-field-key">Team</span>
              <select
                className="k-select"
                value={teamId}
                onChange={(e) => setTeamId(e.target.value)}
              >
                {teams.map((team) => (
                  <option key={team.id} value={team.id}>
                    {team.name ?? team.key}
                  </option>
                ))}
              </select>
            </label>
            <label className="k-field">
              <span className="k-field-key">Priority</span>
              <select
                className="k-select"
                value={priority}
                onChange={(e) => setPriority(Number(e.target.value))}
              >
                {PRIORITIES.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            {cat.raw.projects.length > 0 ? (
              <label className="k-field">
                <span className="k-field-key">Project</span>
                <select
                  className="k-select"
                  value={projectId}
                  onChange={(e) => setProjectId(e.target.value)}
                >
                  <option value="">None</option>
                  {cat.raw.projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name ?? "Project"}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>
          {error ? <div className="k-dialog-error">{error}</div> : null}
        </div>

        <div className="k-dialog-foot">
          <span className="k-dialog-hint">⌘↵ to create</span>
          <button type="button" className="k-btn k-btn--secondary k-btn--sm" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="k-btn k-btn--primary k-btn--sm"
            disabled={busy || !title.trim() || !teamId}
            onClick={() => void submit()}
          >
            {busy ? "Creating…" : "Create work"}
          </button>
        </div>
      </div>
    </div>
  );
}
