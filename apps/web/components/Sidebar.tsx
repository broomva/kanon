import { Inbox, Layers } from "lucide-react";
import Image from "next/image";
import type { CatalogIndex } from "../lib/catalog";
import type { LiveStatus } from "../lib/live";
import type { IssueRecord } from "../lib/types";
import type { Filters } from "./filters";

export interface SidebarProps {
  workspace: string;
  cat: CatalogIndex;
  issues: IssueRecord[];
  filters: Filters;
  onFilter: (next: Filters) => void;
  liveStatus: LiveStatus;
  totalOpen: number;
}

export function Sidebar({
  workspace,
  cat,
  issues,
  filters,
  onFilter,
  liveStatus,
  totalOpen,
}: SidebarProps) {
  const teamCounts = new Map<string, number>();
  const projectCounts = new Map<string, number>();
  for (const issue of issues) {
    if (issue.teamId) teamCounts.set(issue.teamId, (teamCounts.get(issue.teamId) ?? 0) + 1);
    if (issue.projectId)
      projectCounts.set(issue.projectId, (projectCounts.get(issue.projectId) ?? 0) + 1);
  }

  const teams = [...cat.raw.teams].sort((a, b) => (a.key ?? "").localeCompare(b.key ?? ""));
  const projects = cat.raw.projects.filter((p) => (projectCounts.get(p.id) ?? 0) > 0);

  return (
    <aside className="k-sidebar">
      <div className="k-ws">
        <Image
          className="k-ws-logo"
          src="/brand/broomva-blackhole-logo.png"
          alt=""
          width={26}
          height={26}
        />
        <div className="k-ws-meta">
          <span className="k-ws-name">{workspace || "kanon"}</span>
          <span className="k-ws-sub">system of record</span>
        </div>
      </div>

      <nav className="k-nav">
        <button
          type="button"
          className={`k-nav-item${!filters.team && !filters.project ? " is-active" : ""}`}
          onClick={() => onFilter({ ...filters, team: undefined, project: undefined })}
        >
          <Inbox size={16} />
          <span className="k-nav-label">All work</span>
          <span className="k-nav-count">{totalOpen}</span>
        </button>
      </nav>

      {teams.length > 0 ? (
        <div className="k-sb-section">
          <div className="k-sb-section-label">Teams</div>
          {teams.map((team) => (
            <button
              key={team.id}
              type="button"
              className={`k-nav-item${filters.team === team.id ? " is-active" : ""}`}
              onClick={() =>
                onFilter({
                  ...filters,
                  team: filters.team === team.id ? undefined : team.id,
                  project: undefined,
                })
              }
            >
              <span className="k-team-key">{team.key}</span>
              <span className="k-nav-label">{team.name ?? team.key}</span>
              <span className="k-nav-count">{teamCounts.get(team.id) ?? 0}</span>
            </button>
          ))}
        </div>
      ) : null}

      {projects.length > 0 ? (
        <div className="k-sb-section">
          <div className="k-sb-section-label">Projects</div>
          {projects.map((project) => (
            <button
              key={project.id}
              type="button"
              className={`k-nav-item${filters.project === project.id ? " is-active" : ""}`}
              onClick={() =>
                onFilter({
                  ...filters,
                  project: filters.project === project.id ? undefined : project.id,
                  team: undefined,
                })
              }
            >
              <Layers size={15} />
              <span className="k-nav-label">{project.name ?? "Project"}</span>
              <span className="k-nav-count">{projectCounts.get(project.id) ?? 0}</span>
            </button>
          ))}
        </div>
      ) : null}

      <div className="k-sb-spacer" />

      <div className="k-live" data-status={liveStatus}>
        <span className={`k-live-dot k-live-dot--${liveStatus}`} />
        <span className="k-live-text">
          {liveStatus === "live" ? "Live" : liveStatus === "connecting" ? "Connecting" : "Offline"}
        </span>
        <span className="k-live-tenant">one workspace, one log</span>
      </div>
    </aside>
  );
}
