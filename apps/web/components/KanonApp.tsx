"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCatalog, listAgentSessions, listIssues, updateIssue } from "../lib/api";
import { type CatalogIndex, EMPTY_CATALOG, indexCatalog } from "../lib/catalog";
import { useLiveStream } from "../lib/live";
import type { IssueRecord, StateRecord } from "../lib/types";
import { BUCKETS, type Bucket, bucketOf } from "../lib/work-state";
import { Board } from "./Board";
import { CommandMenu } from "./CommandMenu";
import type { Filters } from "./filters";
import { Header, type View } from "./Header";
import { IssueDetail } from "./IssueDetail";
import { IssueList } from "./IssueList";
import { NewIssueDialog } from "./NewIssueDialog";
import { Sidebar } from "./Sidebar";

// The state that a drop lands on, per bucket (first matching state for the team).
const DROP_TYPES: Record<Bucket, string[]> = {
  queued: ["unstarted", "backlog", "triage"],
  started: ["started"],
  done: ["completed"],
  canceled: ["canceled"],
};

export function KanonApp() {
  const [catalog, setCatalog] = useState<CatalogIndex>(() => indexCatalog(EMPTY_CATALOG));
  const [issues, setIssues] = useState<IssueRecord[]>([]);
  const [liveIssueIds, setLiveIssueIds] = useState<Set<string>>(new Set());
  const [filters, setFilters] = useState<Filters>({});
  const [view, setView] = useState<View>("board");
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [selectedRef, setSelectedRef] = useState<string | null>(null);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  // -- data loading -----------------------------------------------------------
  const reload = useCallback(async () => {
    try {
      const [rows, sessions] = await Promise.all([
        listIssues({
          team: filters.team,
          project: filters.project,
          query: filters.query,
          limit: 500,
          orderBy: "updatedAt",
          orderDir: "desc",
        }),
        listAgentSessions({ state: "active" }),
      ]);
      setIssues(rows);
      setLiveIssueIds(
        new Set(sessions.map((s) => s.issueId).filter((id): id is string => Boolean(id))),
      );
      setLoadError(null);
      setLoaded(true);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "could not reach the kanon server");
      setLoaded(true);
    }
  }, [filters.team, filters.project, filters.query]);

  useEffect(() => {
    getCatalog()
      .then((cat) => setCatalog(indexCatalog(cat)))
      .catch(() => {
        /* surfaced through reload's error path */
      });
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // -- live stream: debounce a reload + bump the open detail ------------------
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveStatus = useLiveStream({
    onEvent: () => {
      if (debounce.current) clearTimeout(debounce.current);
      debounce.current = setTimeout(() => {
        void reload();
        setRefreshKey((k) => k + 1);
      }, 250);
    },
  });

  // -- theme ------------------------------------------------------------------
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  // -- ⌘K --------------------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setCmdOpen((v) => !v);
      }
      if (e.key === "Escape" && !cmdOpen && !newOpen && selectedRef) setSelectedRef(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cmdOpen, newOpen, selectedRef]);

  // -- derived ----------------------------------------------------------------
  const visibleIssues = useMemo(() => {
    if (!filters.bucket) return issues;
    return issues.filter((i) => bucketOf(catalog.state(i.stateId)?.stateType) === filters.bucket);
  }, [issues, filters.bucket, catalog]);

  const bucketCounts = useMemo(() => {
    const counts = new Map<Bucket, number>();
    for (const issue of issues) {
      const b = bucketOf(catalog.state(issue.stateId)?.stateType);
      counts.set(b, (counts.get(b) ?? 0) + 1);
    }
    return counts;
  }, [issues, catalog]);

  const openCount = useMemo(
    () =>
      issues.filter(
        (i) => !["done", "canceled"].includes(bucketOf(catalog.state(i.stateId)?.stateType)),
      ).length,
    [issues, catalog],
  );

  // -- optimistic move --------------------------------------------------------
  const onMove = useCallback(
    async (issue: IssueRecord, bucket: Bucket) => {
      let target: StateRecord | undefined;
      for (const type of DROP_TYPES[bucket]) {
        target = catalog.stateForType(issue.teamId, type);
        if (target) break;
      }
      if (!target) return;
      const targetId = target.id;
      const ref = issue.identifier ?? issue.id;
      setIssues((prev) => prev.map((i) => (i.id === issue.id ? { ...i, stateId: targetId } : i)));
      try {
        await updateIssue(ref, { state: targetId });
      } catch {
        void reload(); // revert to server truth
        return;
      }
      void reload();
      setRefreshKey((k) => k + 1);
    },
    [catalog, reload],
  );

  const selectIssue = useCallback((ref: string) => {
    setSelectedRef(ref);
    setCmdOpen(false);
  }, []);

  return (
    <div className={`k-app${selectedRef ? " has-detail" : ""}`}>
      <Sidebar
        workspace={catalog.raw.workspace}
        cat={catalog}
        issues={issues}
        filters={filters}
        onFilter={setFilters}
        liveStatus={liveStatus}
        totalOpen={openCount}
      />

      <div className="k-main">
        <Header
          view={view}
          onView={setView}
          query={filters.query ?? ""}
          onQuery={(q) => setFilters((f) => ({ ...f, query: q || undefined }))}
          onNew={() => setNewOpen(true)}
          onOpenCommand={() => setCmdOpen(true)}
          theme={theme}
          onToggleTheme={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
        />

        <div className="k-chips">
          <button
            type="button"
            className={`k-chip${!filters.bucket ? " is-active" : ""}`}
            onClick={() => setFilters((f) => ({ ...f, bucket: undefined }))}
          >
            All
            <span className="k-chip-count">{issues.length}</span>
          </button>
          {BUCKETS.map((bucket) => (
            <button
              key={bucket.id}
              type="button"
              className={`k-chip${filters.bucket === bucket.id ? " is-active" : ""}`}
              onClick={() =>
                setFilters((f) => ({
                  ...f,
                  bucket: f.bucket === bucket.id ? undefined : bucket.id,
                }))
              }
            >
              {bucket.label}
              <span className="k-chip-count">{bucketCounts.get(bucket.id) ?? 0}</span>
            </button>
          ))}
        </div>

        <div className="k-plane">
          {loadError ? (
            <div className="k-plane-empty">
              <span className="k-empty-title">Can&apos;t reach the workspace</span>
              <span className="k-empty-sub">{loadError}</span>
            </div>
          ) : loaded && issues.length === 0 ? (
            <div className="k-plane-empty">
              <span className="k-empty-title">No work yet</span>
              <span className="k-empty-sub">Press New, or ⌘K, to open the first one.</span>
            </div>
          ) : view === "board" ? (
            <Board
              issues={visibleIssues}
              cat={catalog}
              liveIssueIds={liveIssueIds}
              selectedRef={selectedRef}
              onSelect={selectIssue}
              onMove={onMove}
            />
          ) : (
            <IssueList
              issues={visibleIssues}
              cat={catalog}
              liveIssueIds={liveIssueIds}
              selectedRef={selectedRef}
              onSelect={selectIssue}
            />
          )}
        </div>
      </div>

      {selectedRef ? (
        <IssueDetail
          issueRef={selectedRef}
          cat={catalog}
          refreshKey={refreshKey}
          live={issues.some(
            (i) => (i.identifier ?? i.id) === selectedRef && liveIssueIds.has(i.id),
          )}
          onClose={() => setSelectedRef(null)}
          onChanged={() => {
            void reload();
            setRefreshKey((k) => k + 1);
          }}
        />
      ) : null}

      <CommandMenu
        open={cmdOpen}
        onClose={() => setCmdOpen(false)}
        issues={issues}
        cat={catalog}
        onSelectIssue={selectIssue}
        onNew={() => {
          setCmdOpen(false);
          setNewOpen(true);
        }}
        onView={setView}
        onToggleTheme={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
      />

      <NewIssueDialog
        open={newOpen}
        cat={catalog}
        defaultTeamId={filters.team}
        defaultProjectId={filters.project}
        onClose={() => setNewOpen(false)}
        onCreated={(ref) => {
          setNewOpen(false);
          void reload();
          selectIssue(ref);
        }}
      />
    </div>
  );
}
