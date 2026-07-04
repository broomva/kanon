/**
 * `kanon doctor` — post-merge repair.
 *
 * 1. Duplicate identifiers. Two offline clones can allocate the same
 *    (team, number); after sync both issues exist (the log is append-only —
 *    nothing was lost). Doctor keeps the EARLIER-ULID issue and reassigns
 *    each later one the next free number via a normal update event, so the
 *    repair itself replicates.
 * 2. Watermark drift. meta.json displayCounters below the projection max
 *    (e.g. numbers arrived via sync that this clone never allocated) are
 *    raised to the max — identifiers must never be re-minted.
 */

import { canonicalRelationKey } from "@kanon/store";
import { resolveActor } from "../actor";
import { flagBool, parseFlags } from "../args";
import {
  allocateAndAppend,
  type EventInput,
  openRepo,
  type RepoContext,
  readMeta,
  withMetaLock,
  writeEvents,
  writeMeta,
} from "../context";
import { emit } from "../output";

export interface DuplicateFix {
  identifier: string;
  keptId: string;
  reassignedId: string;
  newIdentifier: string;
}

export interface WatermarkFix {
  team: string;
  from: number;
  to: number;
}

export interface RelationDuplicateFix {
  canonicalKey: string;
  keptId: string;
  tombstonedId: string;
}

export interface CycleReport {
  /** Identifiers (or ULIDs) of the issues forming a `blocks` cycle. */
  issues: string[];
}

export interface DoctorReport {
  ok: boolean;
  duplicates: DuplicateFix[];
  watermarks: WatermarkFix[];
  relationDuplicates: RelationDuplicateFix[];
  /** Blocking cycles — flagged, never auto-repaired (breaking one is a human call). */
  cycles: CycleReport[];
}

/**
 * Post-merge repair against an already-open repo context — reused by both the
 * `kanon doctor` command and `kanon sync` (which surfaces reassignments so
 * agents caching TEAM-N identifiers across syncs learn they were renumbered).
 * Writes repairs to the log (they replicate on the next push); mutates the
 * projection via `allocateAndAppend`'s refresh. Does NOT close the projection —
 * the caller owns the context lifecycle.
 */
export function runDoctorRepair(ctx: RepoContext): DoctorReport {
  const db = ctx.projection.db;
  const duplicates: DuplicateFix[] = [];
  const watermarks: WatermarkFix[] = [];
  const relationDuplicates: RelationDuplicateFix[] = [];
  const cycles: CycleReport[] = [];

  // -- duplicate identifiers ---------------------------------------------------
  const groups = db
    .query<{ team_id: string; number: number }, []>(
      "SELECT team_id, number FROM issues WHERE deleted = 0 AND team_id IS NOT NULL " +
        "AND number IS NOT NULL GROUP BY team_id, number HAVING COUNT(*) > 1 " +
        "ORDER BY team_id, number",
    )
    .all();
  for (const group of groups) {
    const team = db
      .query<{ key: string | null }, [string]>("SELECT key FROM teams WHERE id = ?")
      .get(group.team_id);
    const key = team?.key;
    if (key === null || key === undefined) continue; // no key — no identifiers to collide
    const rows = db
      .query<{ id: string }, [string, number]>(
        "SELECT id FROM issues WHERE deleted = 0 AND team_id = ? AND number = ? ORDER BY id",
      )
      .all(group.team_id, group.number);
    const [kept, ...later] = rows;
    if (kept === undefined) continue;
    for (const row of later) {
      // Locked allocate → update event → refresh, so the next allocation
      // sees it and a concurrent `issue create` cannot race the watermark.
      const { number: newNumber } = allocateAndAppend(ctx, group.team_id, key, (allocated) => [
        { op: "update", model: "issue", modelId: row.id, data: { number: allocated } },
      ]);
      duplicates.push({
        identifier: `${key}-${group.number}`,
        keptId: kept.id,
        reassignedId: row.id,
        newIdentifier: `${key}-${newNumber}`,
      });
    }
  }

  // -- watermark drift (after duplicate fixes) ---------------------------------
  // Locked: the repair is a read-modify-write of the same watermark file
  // concurrent `issue create` processes are allocating from.
  withMetaLock(ctx.dir, () => {
    const meta = readMeta(ctx.dir);
    const counters = meta.displayCounters ?? {};
    const teams = db
      .query<{ id: string; key: string | null }, []>(
        "SELECT id, key FROM teams WHERE key IS NOT NULL ORDER BY key",
      )
      .all();
    let metaChanged = false;
    for (const team of teams) {
      if (team.key === null) continue;
      const row = db
        .query<{ max: number | null }, [string]>(
          "SELECT MAX(number) AS max FROM issues WHERE team_id = ?",
        )
        .get(team.id);
      const max = row?.max ?? 0;
      const current = counters[team.key] ?? 0;
      if (current < max) {
        watermarks.push({ team: team.key, from: current, to: max });
        counters[team.key] = max;
        metaChanged = true;
      }
    }
    if (metaChanged) {
      meta.displayCounters = counters;
      writeMeta(ctx.dir, meta);
    }
  });

  // -- duplicate relation edges (cross-clone) ----------------------------------
  // Two clones that `relate` the same edge offline mint two entities with the
  // same canonical key. Keep the earliest ULID, tombstone the rest, so a single
  // `unrelate` can't leave a duplicate standing (the "issue stays blocked" bug).
  const relationRows = db
    .query<
      {
        id: string;
        rel_type: string | null;
        issue_id: string | null;
        related_issue_id: string | null;
      },
      []
    >(
      "SELECT id, rel_type, issue_id, related_issue_id FROM issue_relations WHERE deleted = 0 ORDER BY id",
    )
    .all();
  const byEdge = new Map<string, string[]>();
  for (const row of relationRows) {
    const key = canonicalRelationKey(row.rel_type, row.issue_id, row.related_issue_id);
    const group = byEdge.get(key);
    if (group) group.push(row.id);
    else byEdge.set(key, [row.id]);
  }
  const relationTombstones: EventInput[] = [];
  for (const [canonicalKey, ids] of byEdge) {
    const [kept, ...extra] = ids;
    if (kept === undefined || extra.length === 0) continue;
    for (const id of extra) {
      relationTombstones.push({ op: "unrelate", model: "issue_relation", modelId: id, data: {} });
      relationDuplicates.push({ canonicalKey, keptId: kept, tombstonedId: id });
    }
  }
  if (relationTombstones.length > 0) writeEvents(ctx, relationTombstones);

  // -- blocking cycles (flagged, not repaired) ---------------------------------
  // A blocks B blocks A hides both from `ready` forever. Report each cycle;
  // breaking it is a human decision, so doctor never auto-tombstones here.
  for (const cycle of detectBlockingCycles(db)) {
    cycles.push({ issues: cycle });
  }

  return {
    ok:
      duplicates.length === 0 &&
      watermarks.length === 0 &&
      relationDuplicates.length === 0 &&
      cycles.length === 0,
    duplicates,
    watermarks,
    relationDuplicates,
    cycles,
  };
}

/**
 * Every distinct `blocks` cycle in the projection, each as a list of issue
 * identifiers (ULIDs when an issue has no identifier). Standard white/grey/black
 * DFS; a grey back-edge closes a cycle, canonicalized by its node set so a→b→a
 * is reported once.
 */
function detectBlockingCycles(db: RepoContext["projection"]["db"]): string[][] {
  const edges = db
    .query<{ issue_id: string; related_issue_id: string }, []>(
      "SELECT issue_id, related_issue_id FROM issue_relations " +
        "WHERE deleted = 0 AND rel_type = 'blocks' AND issue_id IS NOT NULL AND related_issue_id IS NOT NULL",
    )
    .all();
  if (edges.length === 0) return [];
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const out = adjacency.get(edge.issue_id);
    if (out) out.push(edge.related_issue_id);
    else adjacency.set(edge.issue_id, [edge.related_issue_id]);
  }

  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const found = new Map<string, string[]>();

  // Iterative DFS (explicit frame stack) so a deep blocks-chain can't overflow
  // the JS call stack. `path` mirrors the grey ancestors; a grey back-edge to a
  // node on `path` closes a cycle.
  for (const root of adjacency.keys()) {
    if ((color.get(root) ?? WHITE) !== WHITE) continue;
    const frames: { node: string; next: number }[] = [{ node: root, next: 0 }];
    const path: string[] = [root];
    color.set(root, GREY);
    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      if (frame === undefined) break;
      const neighbours = adjacency.get(frame.node) ?? [];
      const child = frame.next < neighbours.length ? neighbours[frame.next] : undefined;
      if (child !== undefined) {
        frame.next += 1;
        const state = color.get(child) ?? WHITE;
        if (state === GREY) {
          const start = path.indexOf(child);
          if (start !== -1) {
            const cycle = path.slice(start);
            const canonical = [...cycle].sort().join("|");
            if (!found.has(canonical)) found.set(canonical, cycle);
          }
        } else if (state === WHITE) {
          color.set(child, GREY);
          path.push(child);
          frames.push({ node: child, next: 0 });
        }
      } else {
        color.set(frame.node, BLACK);
        frames.pop();
        path.pop();
      }
    }
  }

  const identifierOf = (id: string): string => {
    const row = db
      .query<{ identifier: string | null }, [string]>("SELECT identifier FROM issues WHERE id = ?")
      .get(id);
    return row?.identifier ?? id;
  };
  return [...found.values()].map((cycle) => cycle.map(identifierOf));
}

export function doctor(argv: string[]): void {
  const { flags } = parseFlags(
    argv,
    { json: "boolean", repo: "value" },
    { min: 0, max: 0, usage: "kanon doctor" },
  );
  const ctx = openRepo(flags, resolveActor());
  const report = runDoctorRepair(ctx);
  emit(flagBool(flags, "json"), report, () => {
    if (report.ok) {
      console.log("ok — no duplicate identifiers, watermarks consistent, edges clean");
      return;
    }
    for (const fix of report.duplicates) {
      console.log(
        `duplicate ${fix.identifier}: kept ${fix.keptId}, reassigned ${fix.reassignedId} ` +
          `→ ${fix.newIdentifier}`,
      );
    }
    for (const fix of report.watermarks) {
      console.log(`watermark ${fix.team}: ${fix.from} → ${fix.to}`);
    }
    for (const fix of report.relationDuplicates) {
      console.log(
        `duplicate edge ${fix.canonicalKey}: kept ${fix.keptId}, tombstoned ${fix.tombstonedId}`,
      );
    }
    for (const cycle of report.cycles) {
      console.log(
        `blocking cycle: ${cycle.issues.join(" → ")} → ${cycle.issues[0]} (break it manually)`,
      );
    }
    if (
      report.duplicates.length > 0 ||
      report.watermarks.length > 0 ||
      report.relationDuplicates.length > 0
    ) {
      console.log("repairs written to the log — run `kanon sync` to replicate them");
    }
  });
  ctx.projection.close();
}
