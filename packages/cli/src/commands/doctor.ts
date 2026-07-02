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

import { resolveActor } from "../actor";
import { flagBool, parseFlags } from "../args";
import { allocateAndAppend, openRepo, readMeta, withMetaLock, writeMeta } from "../context";
import { emit } from "../output";

interface DuplicateFix {
  identifier: string;
  keptId: string;
  reassignedId: string;
  newIdentifier: string;
}

interface WatermarkFix {
  team: string;
  from: number;
  to: number;
}

export function doctor(argv: string[]): void {
  const { flags } = parseFlags(
    argv,
    { json: "boolean", repo: "value" },
    { min: 0, max: 0, usage: "kanon doctor" },
  );
  const ctx = openRepo(flags, resolveActor());
  const db = ctx.projection.db;
  const duplicates: DuplicateFix[] = [];
  const watermarks: WatermarkFix[] = [];

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

  const ok = duplicates.length === 0 && watermarks.length === 0;
  emit(flagBool(flags, "json"), { ok, duplicates, watermarks }, () => {
    if (ok) {
      console.log("ok — no duplicate identifiers, watermarks consistent");
      return;
    }
    for (const fix of duplicates) {
      console.log(
        `duplicate ${fix.identifier}: kept ${fix.keptId}, reassigned ${fix.reassignedId} ` +
          `→ ${fix.newIdentifier}`,
      );
    }
    for (const fix of watermarks) {
      console.log(`watermark ${fix.team}: ${fix.from} → ${fix.to}`);
    }
    console.log("repairs written to the log — run `kanon sync` to replicate them");
  });
  ctx.projection.close();
}
