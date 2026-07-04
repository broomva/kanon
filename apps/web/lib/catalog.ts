import type {
  ActorRecord,
  Catalog,
  LabelRecord,
  ProjectRecord,
  StateRecord,
  TeamRecord,
} from "./types";

// A cheap index over the catalog so components can resolve the ids carried on
// an issue (stateId / labelIds / assigneeId / …) without scanning arrays.
export interface CatalogIndex {
  raw: Catalog;
  state(id: string | null | undefined): StateRecord | undefined;
  team(id: string | null | undefined): TeamRecord | undefined;
  actor(id: string | null | undefined): ActorRecord | undefined;
  label(id: string | null | undefined): LabelRecord | undefined;
  project(id: string | null | undefined): ProjectRecord | undefined;
  actorName(id: string | null | undefined): string;
  /** The first state of a given type for a team — the drag-drop landing target. */
  stateForType(teamId: string | null | undefined, type: string): StateRecord | undefined;
}

function toMap<T extends { id: string }>(rows: T[]): Map<string, T> {
  return new Map(rows.map((row) => [row.id, row]));
}

export function indexCatalog(raw: Catalog): CatalogIndex {
  const states = toMap(raw.states);
  const teams = toMap(raw.teams);
  const actors = toMap(raw.actors);
  const labels = toMap(raw.labels);
  const projects = toMap(raw.projects);

  return {
    raw,
    state: (id) => (id ? states.get(id) : undefined),
    team: (id) => (id ? teams.get(id) : undefined),
    actor: (id) => (id ? actors.get(id) : undefined),
    label: (id) => (id ? labels.get(id) : undefined),
    project: (id) => (id ? projects.get(id) : undefined),
    actorName: (id) => {
      if (!id) return "";
      const a = actors.get(id);
      return a?.displayName || a?.name || a?.email || "";
    },
    stateForType: (teamId, type) => {
      const candidates = raw.states
        .filter((s) => s.stateType === type && (teamId ? s.teamId === teamId : true))
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
      return candidates[0];
    },
  };
}

export const EMPTY_CATALOG: Catalog = {
  workspace: "",
  teams: [],
  states: [],
  projects: [],
  labels: [],
  actors: [],
  milestones: [],
};

export function projectName(project: ProjectRecord | undefined): string {
  return project?.name ?? "";
}

export function labelName(label: LabelRecord | undefined): string {
  return label?.name ?? "";
}
