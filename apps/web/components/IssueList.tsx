import type { CatalogIndex } from "../lib/catalog";
import { relativeTime } from "../lib/format";
import type { IssueRecord } from "../lib/types";
import { BUCKETS, type Bucket, bucketOf } from "../lib/work-state";
import { Avatar, PriorityMark, StateDot } from "./primitives";

export interface IssueListProps {
  issues: IssueRecord[];
  cat: CatalogIndex;
  liveIssueIds: Set<string>;
  selectedRef: string | null;
  onSelect: (ref: string) => void;
}

// Grouped list — one section per bucket, rows sorted by the plane's incoming
// order. The dense, scannable projection (the board's calmer sibling).
export function IssueList({ issues, cat, liveIssueIds, selectedRef, onSelect }: IssueListProps) {
  const byBucket = new Map<Bucket, IssueRecord[]>();
  for (const bucket of BUCKETS) byBucket.set(bucket.id, []);
  for (const issue of issues)
    byBucket.get(bucketOf(cat.state(issue.stateId)?.stateType))?.push(issue);

  return (
    <div className="k-list">
      {BUCKETS.map((bucket) => {
        const list = byBucket.get(bucket.id) ?? [];
        if (list.length === 0) return null;
        return (
          <section key={bucket.id} className="k-list-group">
            <div className="k-list-group-head">
              <span className="k-list-group-title">{bucket.label}</span>
              <span className="k-col-count">{list.length}</span>
            </div>
            {list.map((issue) => {
              const ref = issue.identifier ?? issue.id;
              const state = cat.state(issue.stateId);
              const project = cat.project(issue.projectId);
              const assignee = cat.actorName(issue.assigneeId);
              const delegate = cat.actorName(issue.delegateId);
              return (
                <button
                  key={issue.id}
                  type="button"
                  className={`k-row${ref === selectedRef ? " is-selected" : ""}`}
                  onClick={() => onSelect(ref)}
                >
                  <StateDot stateType={state?.stateType} live={liveIssueIds.has(issue.id)} />
                  <PriorityMark priority={issue.priority} />
                  <span className="k-row-ref">{ref}</span>
                  <span className="k-row-title">{issue.title ?? "Untitled"}</span>
                  <span className="k-row-crumb">{project?.name ?? ""}</span>
                  <span className="k-row-avatars">
                    {delegate ? (
                      <Avatar
                        name={delegate}
                        size={18}
                        kind="agent"
                        title={`delegate ${delegate}`}
                      />
                    ) : null}
                    {assignee ? (
                      <Avatar name={assignee} size={18} title={`assignee ${assignee}`} />
                    ) : null}
                  </span>
                  <span className="k-row-time">{relativeTime(issue.updatedAt)}</span>
                </button>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}
