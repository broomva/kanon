import { describe, expect, test } from "bun:test";
import { type KanonEvent, segmentName, validateEvent } from "@kanon/core";
import fixtureJson from "../fixtures/export.small.json";
import { buildIdMap } from "./data-repo";
import { displayCounters, normalizeTs, relationKey, transform } from "./transform";
import type { LinearExport, LinearIssueExport } from "./types";

const fixture = fixtureJson as unknown as LinearExport;

function freshExport(): LinearExport {
  return structuredClone(fixture);
}

function findCreate(events: KanonEvent[], linearId: string): KanonEvent {
  const event = events.find(
    (e) => (e.op === "create" || e.op === "relate") && e.data.linearId === linearId,
  );
  if (event === undefined) throw new Error(`no create event for ${linearId}`);
  return event;
}

function findIssue(exp: LinearExport, linearId: string): LinearIssueExport {
  const issue = exp.issues.find((i) => i.linearId === linearId);
  if (issue === undefined) throw new Error(`no fixture issue ${linearId}`);
  return issue;
}

describe("transform — fresh import", () => {
  const { events, summary } = transform(freshExport(), new Map());

  test("emits only valid events", () => {
    expect(events.length).toBe(22);
    for (const event of events) {
      const result = validateEvent(event);
      expect(result.errors).toEqual([]);
      expect(result.ok).toBe(true);
    }
  });

  test("summary counts every entity once and drops nothing", () => {
    expect(summary.created).toBe(21);
    expect(summary.updated).toBe(0);
    expect(summary.skipped).toBe(0);
    expect(summary.droppedRefs).toEqual([]);
    expect(summary.droppedByModel).toEqual({});
    expect(summary.byModel.team?.created).toBe(1);
    expect(summary.byModel.workflow_state?.created).toBe(7);
    expect(summary.byModel.label?.created).toBe(2);
    expect(summary.byModel.actor?.created).toBe(2);
    expect(summary.byModel.project?.created).toBe(1);
    expect(summary.byModel.milestone?.created).toBe(1);
    expect(summary.byModel.issue?.created).toBe(4);
    expect(summary.byModel.issue_relation?.created).toBe(1);
    expect(summary.byModel.comment?.created).toBe(2);
  });

  test("event ids strictly increase in emission order", () => {
    for (let i = 1; i < events.length; i++) {
      const prev = events[i - 1];
      const next = events[i];
      if (prev === undefined || next === undefined) throw new Error("unreachable");
      expect(next.id > prev.id).toBe(true);
    }
  });

  test("every event is attributed to the import app actor", () => {
    for (const event of events) {
      expect(event.actor).toEqual({ type: "app", id: "linear-import", surface: "import" });
      expect(event.workspace).toBe("broomva");
    }
  });

  test("preserves Linear display identifiers as data", () => {
    const issueCreates = events.filter((e) => e.model === "issue" && e.op === "create");
    const numbers = issueCreates.map((e) => e.data.number).sort();
    expect(numbers).toEqual([1643, 1644, 1645, 1646]);
    const identifiers = issueCreates.map((e) => e.data.identifier).sort();
    expect(identifiers).toEqual(["BRO-1643", "BRO-1644", "BRO-1645", "BRO-1646"]);
    expect(findCreate(events, "lin-team-bro").data.key).toBe("BRO");
  });

  test("every entity's data carries its linearId; modelIds are fresh ULIDs", () => {
    const creates = events.filter((e) => e.op === "create" || e.op === "relate");
    expect(creates.length).toBe(21);
    for (const event of creates) {
      expect(typeof event.data.linearId).toBe("string");
      expect(event.modelId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    }
  });

  test("event ts follows Linear updatedAt (fallback createdAt)", () => {
    const issue1644 = findCreate(events, "lin-issue-1644");
    expect(issue1644.ts).toBe("2026-06-27T16:30:00.000Z");
    const comment = findCreate(events, "lin-comment-1");
    expect(comment.ts).toBe("2026-06-22T08:00:00.000Z");
  });

  test("users become actors with actorType from isAgent", () => {
    expect(findCreate(events, "lin-user-carlos").data.actorType).toBe("human");
    const agent = findCreate(events, "lin-user-claude");
    expect(agent.model).toBe("actor");
    expect(agent.data.actorType).toBe("agent");
  });

  test("cross-references are mapped linearId → modelId", () => {
    const teamId = findCreate(events, "lin-team-bro").modelId;
    const stateId = findCreate(events, "lin-state-in-progress").modelId;
    const assigneeId = findCreate(events, "lin-user-claude").modelId;
    const projectId = findCreate(events, "lin-project-kanon").modelId;
    const milestoneId = findCreate(events, "lin-milestone-m1").modelId;
    const labelId = findCreate(events, "lin-label-feature").modelId;

    const issue = findCreate(events, "lin-issue-1644");
    expect(issue.data.teamId).toBe(teamId);
    expect(issue.data.stateId).toBe(stateId);
    expect(issue.data.assigneeId).toBe(assigneeId);
    expect(issue.data.projectId).toBe(projectId);
    expect(issue.data.milestoneId).toBe(milestoneId);
    expect(issue.data.labelIds).toEqual([labelId]);

    const milestone = findCreate(events, "lin-milestone-m1");
    expect(milestone.data.projectId).toBe(projectId);
    const project = findCreate(events, "lin-project-kanon");
    expect(project.data.teamIds).toEqual([teamId]);
    expect(project.data.leadId).toBe(findCreate(events, "lin-user-carlos").modelId);
  });

  test("sub-issue parentId resolves inline when the parent precedes it", () => {
    const parent = findCreate(events, "lin-issue-1644");
    const child = findCreate(events, "lin-issue-1646");
    expect(child.data.parentId).toBe(parent.modelId);
    expect(events.filter((e) => e.op === "update")).toEqual([]);
  });

  test("archived issue: create (no data flag) then explicit archive op", () => {
    const create = findCreate(events, "lin-issue-1643");
    expect("archived" in create.data).toBe(false); // explicit ops are the one mechanism
    const archive = events.find((e) => e.op === "archive");
    if (archive === undefined) throw new Error("no archive event");
    expect(archive.model).toBe("issue");
    expect(archive.modelId).toBe(create.modelId);
    expect(archive.data.linearId).toBe("lin-issue-1643");
    expect(archive.ts).toBe("2026-06-26T09:00:00.000Z");
    expect(events.indexOf(archive)).toBe(events.indexOf(create) + 1);
    const active = findCreate(events, "lin-issue-1644");
    expect("archived" in active.data).toBe(false);
  });

  test("relations become issue_relation relate events with a synthetic linearId", () => {
    const relation = events.find((e) => e.model === "issue_relation");
    if (relation === undefined) throw new Error("no relation event");
    expect(relation.op).toBe("relate");
    expect(relation.data.type).toBe("blocks");
    expect(relation.data.issueId).toBe(findCreate(events, "lin-issue-1644").modelId);
    expect(relation.data.relatedIssueId).toBe(findCreate(events, "lin-issue-1645").modelId);
    expect(relation.data.linearId).toBe(relationKey("lin-issue-1644", "blocks", "lin-issue-1645"));
  });

  test("comment replies map parentId to the parent comment's modelId", () => {
    const top = findCreate(events, "lin-comment-1");
    const reply = findCreate(events, "lin-comment-2");
    expect(top.data.parentId).toBeUndefined();
    expect(reply.data.parentId).toBe(top.modelId);
    expect(reply.data.issueId).toBe(findCreate(events, "lin-issue-1644").modelId);
    expect(reply.data.actorId).toBe(findCreate(events, "lin-user-claude").modelId);
    expect(reply.data.linearCreatedAt).toBe("2026-06-22T09:15:00.000Z");
  });
});

describe("transform — idempotency", () => {
  test("re-run with the map built from the first run emits 0 events", () => {
    const first = transform(freshExport(), new Map());
    const map = buildIdMap(first.events);
    const second = transform(freshExport(), map);
    expect(second.events).toEqual([]);
    expect(second.summary.created).toBe(0);
    expect(second.summary.updated).toBe(0);
    expect(second.summary.skipped).toBe(21);
    expect(second.summary.droppedRefs).toEqual([]);
  });

  test("changed updatedAt + title yields exactly one update event", () => {
    const first = transform(freshExport(), new Map());
    const map = buildIdMap(first.events);

    const changed = freshExport();
    const issue = findIssue(changed, "lin-issue-1645");
    issue.title = "SQLite projection (revised scope)";
    issue.updatedAt = "2026-06-30T09:00:00.000Z";

    const second = transform(changed, map);
    expect(second.events.length).toBe(1);
    const update = second.events[0];
    if (update === undefined) throw new Error("unreachable");
    expect(update.op).toBe("update");
    expect(update.model).toBe("issue");
    expect(update.modelId).toBe(findCreate(first.events, "lin-issue-1645").modelId);
    expect(update.data.title).toBe("SQLite projection (revised scope)");
    expect(update.data.linearUpdatedAt).toBe("2026-06-30T09:00:00.000Z");
    expect(update.ts).toBe("2026-06-30T09:00:00.000Z");
    expect(second.summary.updated).toBe(1);
    expect(second.summary.created).toBe(0);

    // and the update advances the watermark: a third run is a no-op again
    const third = transform(changed, buildIdMap([...first.events, ...second.events]));
    expect(third.events).toEqual([]);
  });

  test("existing map entries keep their modelIds across runs", () => {
    const first = transform(freshExport(), new Map());
    const map = buildIdMap(first.events);
    const entry = map.get("lin-issue-1644");
    if (entry === undefined) throw new Error("missing map entry");
    expect(entry.modelId).toBe(findCreate(first.events, "lin-issue-1644").modelId);
    expect(entry.updatedAt).toBe("2026-06-27T16:30:00.000Z");
    expect(entry.archived).toBeUndefined();
    expect(map.get("lin-issue-1643")?.archived).toBe(true);
  });
});

describe("transform — archival transitions", () => {
  test("unarchive in Linear emits update + explicit unarchive op", () => {
    const first = transform(freshExport(), new Map());
    const map = buildIdMap(first.events);

    const changed = freshExport();
    const issue = findIssue(changed, "lin-issue-1643");
    delete issue.archivedAt; // restored in Linear
    issue.updatedAt = "2026-06-29T10:00:00.000Z";

    const second = transform(changed, map);
    expect(second.events.length).toBe(2);
    const [update, unarchive] = second.events;
    if (update === undefined || unarchive === undefined) throw new Error("unreachable");
    expect(update.op).toBe("update");
    expect(unarchive.op).toBe("unarchive");
    expect(unarchive.modelId).toBe(update.modelId);
    expect(unarchive.data.linearId).toBe("lin-issue-1643");

    // the log now folds back to archived: false — and a re-run is a no-op
    const map3 = buildIdMap([...first.events, ...second.events]);
    expect(map3.get("lin-issue-1643")?.archived).toBe(false);
    expect(transform(changed, map3).events).toEqual([]);
  });

  test("archive in Linear emits update + explicit archive op (no data flag)", () => {
    const first = transform(freshExport(), new Map());
    const map = buildIdMap(first.events);

    const changed = freshExport();
    const issue = findIssue(changed, "lin-issue-1645");
    issue.updatedAt = "2026-07-01T12:00:00.000Z";
    issue.archivedAt = "2026-07-01T12:00:00.000Z";

    const second = transform(changed, map);
    expect(second.events.length).toBe(2);
    const [update, archive] = second.events;
    if (update === undefined || archive === undefined) throw new Error("unreachable");
    expect(update.op).toBe("update");
    expect("archived" in update.data).toBe(false);
    expect(archive.op).toBe("archive");
    expect(archive.modelId).toBe(update.modelId);

    // staying archived on the next watermark move emits NO second archive op
    const map3 = buildIdMap([...first.events, ...second.events]);
    const changedAgain = structuredClone(changed);
    findIssue(changedAgain, "lin-issue-1645").updatedAt = "2026-07-02T08:00:00.000Z";
    const third = transform(changedAgain, map3);
    expect(third.events.length).toBe(1);
    expect(third.events[0]?.op).toBe("update");
  });
});

describe("transform — timestamp normalization", () => {
  test("normalizeTs canonicalizes offsets and locale-ish strings to UTC ISO", () => {
    expect(normalizeTs("2026-06-27T19:30:00.000+03:00")).toBe("2026-06-27T16:30:00.000Z");
    expect(normalizeTs("2026-06-30T23:30:00.000-05:00")).toBe("2026-07-01T04:30:00.000Z");
    expect(normalizeTs(undefined)).toBeUndefined();
    expect(normalizeTs("not a date")).toBeUndefined();
  });

  test("event ts and watermark are normalized so segments route by UTC month", () => {
    const exp = freshExport();
    const issue = findIssue(exp, "lin-issue-1645");
    // +03:00 offset: local July 1st but UTC June 30th — must route to 2026-06
    issue.updatedAt = "2026-07-01T02:30:00.000+03:00";

    const { events } = transform(exp, new Map());
    const create = findCreate(events, "lin-issue-1645");
    expect(create.ts).toBe("2026-06-30T23:30:00.000Z");
    expect(create.data.linearUpdatedAt).toBe("2026-06-30T23:30:00.000Z");
    expect(segmentName(create.ts)).toBe("2026-06.jsonl");
    for (const event of events) {
      expect(segmentName(event.ts)).toMatch(/^\d{4}-\d{2}\.jsonl$/);
    }

    // watermark comparison is normalized-to-normalized: re-run is a no-op
    // even though the export still carries the offset representation
    const second = transform(structuredClone(exp), buildIdMap(events));
    expect(second.events).toEqual([]);
  });
});

describe("transform — dropped cross-references", () => {
  test("unresolvable refs are dropped from data but recorded in the summary", () => {
    const exp = freshExport();
    const issue = findIssue(exp, "lin-issue-1645");
    issue.stateLinearId = "lin-state-missing";
    issue.relations.push({ type: "blocks", relatedIssueLinearId: "lin-issue-elsewhere" });

    const { events, summary } = transform(exp, new Map());
    const create = findCreate(events, "lin-issue-1645");
    expect("stateId" in create.data).toBe(false);
    expect(events.filter((e) => e.model === "issue_relation").length).toBe(1); // dangling one dropped

    expect(summary.droppedRefs).toEqual([
      {
        model: "issue",
        linearId: "lin-issue-1645",
        field: "stateId",
        ref: "lin-state-missing",
      },
      {
        model: "issue_relation",
        linearId: relationKey("lin-issue-1645", "blocks", "lin-issue-elsewhere"),
        field: "relatedIssueId",
        ref: "lin-issue-elsewhere",
      },
    ]);
    expect(summary.droppedByModel).toEqual({ issue: 1, issue_relation: 1 });
  });

  test("a parent missing from the export is a dropped ref, not a silent omission", () => {
    const exp = freshExport();
    findIssue(exp, "lin-issue-1646").parentLinearId = "lin-issue-gone";

    const { events, summary } = transform(exp, new Map());
    expect(findCreate(events, "lin-issue-1646").data.parentId).toBeUndefined();
    expect(events.filter((e) => e.op === "update")).toEqual([]); // no fixup emitted
    expect(summary.droppedRefs).toEqual([
      { model: "issue", linearId: "lin-issue-1646", field: "parentId", ref: "lin-issue-gone" },
    ]);
  });

  test("skipped entities never re-record dropped refs on re-runs", () => {
    const exp = freshExport();
    findIssue(exp, "lin-issue-1645").stateLinearId = "lin-state-missing";
    const first = transform(exp, new Map());
    expect(first.summary.droppedRefs.length).toBe(1);
    const second = transform(structuredClone(exp), buildIdMap(first.events));
    expect(second.summary.droppedRefs).toEqual([]);
  });
});

describe("transform — forward-referenced parent", () => {
  const miniExport: LinearExport = {
    workspace: "broomva",
    teams: [
      {
        linearId: "lin-team-mini",
        key: "MIN",
        name: "Mini",
        states: [],
      },
    ],
    labels: [],
    users: [],
    projects: [],
    milestones: [],
    initiatives: [],
    issues: [
      {
        linearId: "lin-issue-child",
        teamLinearId: "lin-team-mini",
        number: 2,
        identifier: "MIN-2",
        title: "Child listed before its parent",
        parentLinearId: "lin-issue-parent",
        labelLinearIds: [],
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-02T00:00:00.000Z",
        relations: [],
      },
      {
        linearId: "lin-issue-parent",
        teamLinearId: "lin-team-mini",
        number: 1,
        identifier: "MIN-1",
        title: "Parent",
        labelLinearIds: [],
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:00:00.000Z",
        relations: [],
      },
    ],
    comments: [],
  };

  test("child is created without parentId, then patched by one update event", () => {
    const { events, summary } = transform(structuredClone(miniExport), new Map());
    const child = findCreate(events, "lin-issue-child");
    const parent = findCreate(events, "lin-issue-parent");
    expect(child.data.parentId).toBeUndefined();

    const updates = events.filter((e) => e.op === "update");
    expect(updates.length).toBe(1);
    const fixup = updates[0];
    if (fixup === undefined) throw new Error("unreachable");
    expect(fixup.modelId).toBe(child.modelId);
    expect(fixup.data.parentId).toBe(parent.modelId);
    expect(fixup.data.linearId).toBe("lin-issue-child");
    // the patch lands after both creates — no forward modelId references in the log
    expect(events.indexOf(fixup)).toBeGreaterThan(events.indexOf(parent));
    expect(summary.droppedRefs).toEqual([]); // in-export forward ref is not a drop
    for (const event of events) {
      expect(validateEvent(event).ok).toBe(true);
    }
  });

  test("forward-ref run is still idempotent", () => {
    const first = transform(structuredClone(miniExport), new Map());
    const second = transform(structuredClone(miniExport), buildIdMap(first.events));
    expect(second.events).toEqual([]);
  });
});

describe("displayCounters", () => {
  test("takes the max imported issue number per team key", () => {
    expect(displayCounters(freshExport())).toEqual({ BRO: 1646 });
  });

  test("ignores issues whose team is not in the export", () => {
    const exp = freshExport();
    findIssue(exp, "lin-issue-1646").teamLinearId = "lin-team-unknown";
    expect(displayCounters(exp)).toEqual({ BRO: 1645 });
  });
});
