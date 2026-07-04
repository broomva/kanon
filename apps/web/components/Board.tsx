"use client";

import { useState } from "react";
import type { CatalogIndex } from "../lib/catalog";
import type { IssueRecord } from "../lib/types";
import { BUCKETS, type Bucket, bucketOf } from "../lib/work-state";
import { IssueCard } from "./IssueCard";
import { ToneDot } from "./primitives";

export interface BoardProps {
  issues: IssueRecord[];
  cat: CatalogIndex;
  liveIssueIds: Set<string>;
  selectedRef: string | null;
  onSelect: (ref: string) => void;
  onMove: (issue: IssueRecord, bucket: Bucket) => void;
}

// Board: one column per plain-voice bucket. Cards drag between columns; the drop
// optimistically moves the issue to the target team's representative state.
export function Board({ issues, cat, liveIssueIds, selectedRef, onSelect, onMove }: BoardProps) {
  const [dragRef, setDragRef] = useState<string | null>(null);
  const [overBucket, setOverBucket] = useState<Bucket | null>(null);

  const byBucket = new Map<Bucket, IssueRecord[]>();
  for (const bucket of BUCKETS) byBucket.set(bucket.id, []);
  for (const issue of issues) {
    const bucket = bucketOf(cat.state(issue.stateId)?.stateType);
    byBucket.get(bucket)?.push(issue);
  }

  const dragged = issues.find((i) => (i.identifier ?? i.id) === dragRef);

  return (
    <div className="k-board">
      {BUCKETS.map((bucket) => {
        const list = byBucket.get(bucket.id) ?? [];
        const canDrop = dragged
          ? bucketOf(cat.state(dragged.stateId)?.stateType) !== bucket.id
          : false;
        return (
          // biome-ignore lint/a11y/noStaticElementInteractions: DnD drop target
          <div
            key={bucket.id}
            className={`k-col${overBucket === bucket.id && canDrop ? " is-over" : ""}`}
            onDragOver={(e) => {
              if (!canDrop) return;
              e.preventDefault();
              setOverBucket(bucket.id);
            }}
            onDragLeave={() => setOverBucket((b) => (b === bucket.id ? null : b))}
            onDrop={(e) => {
              e.preventDefault();
              setOverBucket(null);
              const ref = e.dataTransfer.getData("text/plain") || dragRef;
              const issue = issues.find((i) => (i.identifier ?? i.id) === ref);
              setDragRef(null);
              if (issue && bucketOf(cat.state(issue.stateId)?.stateType) !== bucket.id) {
                onMove(issue, bucket.id);
              }
            }}
          >
            <div className="k-col-head">
              <ToneDot tone={bucket.tone} />
              <span className="k-col-title">{bucket.label}</span>
              <span className="k-col-count">{list.length}</span>
            </div>
            <div className="k-col-hint">{bucket.hint}</div>
            <div className="k-col-body">
              {list.map((issue) => (
                <IssueCard
                  key={issue.id}
                  issue={issue}
                  cat={cat}
                  live={liveIssueIds.has(issue.id)}
                  selected={(issue.identifier ?? issue.id) === selectedRef}
                  dragging={(issue.identifier ?? issue.id) === dragRef}
                  onSelect={onSelect}
                  onDragStart={setDragRef}
                  onDragEnd={() => {
                    setDragRef(null);
                    setOverBucket(null);
                  }}
                />
              ))}
              {list.length === 0 ? <div className="k-col-empty">Nothing here</div> : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
