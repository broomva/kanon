/** `kanon project create|list` and `kanon milestone create|list`. */

import { ulid } from "@kanon/core";
import { listMilestones, listProjects, resolveProjects } from "@kanon/store";
import { resolveActor } from "../actor";
import { CliError, flagBool, flagString, parseFlags, requireFlag } from "../args";
import { compact, openRepo, writeEvents } from "../context";
import { emit } from "../output";
import { requireProject } from "../refs";

const COMMON = { json: "boolean", repo: "value" } as const;

export function projectCreate(argv: string[]): void {
  const { flags } = parseFlags(
    argv,
    { ...COMMON, name: "value", description: "value", "target-date": "value" },
    { min: 0, max: 0, usage: "kanon project create --name Kanon [--description ...]" },
  );
  const name = requireFlag(flags, "name");
  const ctx = openRepo(flags, resolveActor());
  if (resolveProjects(ctx.projection.db, name).length > 0) {
    throw new CliError(`a project named "${name}" already exists`);
  }
  const projectId = ulid();
  writeEvents(ctx, [
    {
      op: "create",
      model: "project",
      modelId: projectId,
      data: compact({
        name,
        description: flagString(flags, "description"),
        targetDate: flagString(flags, "target-date"),
      }),
    },
  ]);
  emit(flagBool(flags, "json"), { id: projectId, name }, () => {
    console.log(`created project ${name} (${projectId})`);
  });
  ctx.projection.close();
}

export function projectList(argv: string[]): void {
  const { flags } = parseFlags(argv, COMMON, { min: 0, max: 0, usage: "kanon project list" });
  const ctx = openRepo(flags, resolveActor());
  const projects = listProjects(ctx.projection.db);
  emit(flagBool(flags, "json"), projects, () => {
    if (projects.length === 0) {
      console.log("no projects");
      return;
    }
    for (const project of projects) {
      console.log(`${project.name ?? "?"}  ${project.state ?? ""}  (${project.id})`);
    }
  });
  ctx.projection.close();
}

export function milestoneCreate(argv: string[]): void {
  const { flags } = parseFlags(
    argv,
    { ...COMMON, name: "value", project: "value", "target-date": "value" },
    { min: 0, max: 0, usage: "kanon milestone create --name M1 --project Kanon" },
  );
  const name = requireFlag(flags, "name");
  const ctx = openRepo(flags, resolveActor());
  const project = requireProject(ctx.projection.db, requireFlag(flags, "project"));
  const milestoneId = ulid();
  writeEvents(ctx, [
    {
      op: "create",
      model: "milestone",
      modelId: milestoneId,
      data: compact({
        name,
        projectId: project.id,
        targetDate: flagString(flags, "target-date"),
      }),
    },
  ]);
  emit(flagBool(flags, "json"), { id: milestoneId, name, projectId: project.id }, () => {
    console.log(`created milestone ${name} in ${project.name} (${milestoneId})`);
  });
  ctx.projection.close();
}

export function milestoneList(argv: string[]): void {
  const { flags } = parseFlags(
    argv,
    { ...COMMON, project: "value" },
    { min: 0, max: 0, usage: "kanon milestone list --project Kanon" },
  );
  const ctx = openRepo(flags, resolveActor());
  const projectFlag = flagString(flags, "project");
  const milestones =
    projectFlag === undefined
      ? listMilestones(ctx.projection.db)
      : listMilestones(ctx.projection.db, requireProject(ctx.projection.db, projectFlag).id);
  emit(flagBool(flags, "json"), milestones, () => {
    if (milestones.length === 0) {
      console.log("no milestones");
      return;
    }
    for (const milestone of milestones) {
      console.log(`${milestone.name ?? "?"}  ${milestone.targetDate ?? ""}  (${milestone.id})`);
    }
  });
  ctx.projection.close();
}
