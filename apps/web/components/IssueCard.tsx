import type { CatalogIndex } from "../lib/catalog";
import type { IssueRecord } from "../lib/types";
import { bucketMeta, bucketOf } from "../lib/work-state";
import { Avatar, PriorityMark, StateDot } from "./primitives";

export interface IssueCardProps {
  issue: IssueRecord;
  cat: CatalogIndex;
  live: boolean;
  selected: boolean;
  onSelect: (ref: string) => void;
  onDragStart?: (ref: string) => void;
}

// The work card. Matte at rest; when a live agent session runs on the issue it
// is wrapped in the Undertow (a breathing halo, not a colored border).
export function IssueCard({ issue, cat, live, selected, onSelect, onDragStart }: IssueCardProps) {
  const state = cat.state(issue.stateId);
  const bucket = bucketMeta(bucketOf(state?.stateType));
  const ref = issue.identifier ?? issue.id;
  const project = cat.project(issue.projectId);
  const assignee = cat.actorName(issue.assigneeId);
  const delegate = cat.actorName(issue.delegateId);
  const labels = issue.labelIds
    .map((id) => cat.label(id))
    .filter((l): l is NonNullable<typeof l> => Boolean(l))
    .slice(0, 3);

  const card = (
    <button
      type="button"
      className={`k-card${selected ? " is-selected" : ""}`}
      onClick={() => onSelect(ref)}
      draggable={Boolean(onDragStart)}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", ref);
        e.dataTransfer.effectAllowed = "move";
        onDragStart?.(ref);
      }}
    >
      <div className="k-card-top">
        <span className="k-card-ref">{ref}</span>
        <PriorityMark priority={issue.priority} />
      </div>
      <div className="k-card-title">{issue.title ?? "Untitled"}</div>
      <div className="k-card-foot">
        <span className="k-card-state">
          <StateDot stateType={state?.stateType} live={live} />
          {live ? "Running" : bucket.label}
        </span>
        {project?.name ? <span className="k-card-crumb">{project.name}</span> : null}
        <span className="k-card-spacer" />
        {labels.map((label) => (
          <span key={label.id} className="k-tag">
            {label.name}
          </span>
        ))}
        {delegate ? (
          <Avatar name={delegate} size={20} kind="agent" title={`delegate ${delegate}`} />
        ) : null}
        {assignee ? <Avatar name={assignee} size={20} title={`assignee ${assignee}`} /> : null}
      </div>
    </button>
  );

  if (!live) return card;
  return (
    <div className="bv-undertow">
      <span className="bv-undertow-orbit" />
      {card}
    </div>
  );
}
