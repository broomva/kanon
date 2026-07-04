/**
 * Linear-server tool schemas — the PARITY ORACLE.
 *
 * Each entry is the tool's `description` + JSON-Schema `inputSchema` ported
 * VERBATIM from the live `linear-server` MCP (captured 2026-07-02). The MCP
 * server advertises exactly these so an agent prompt written against
 * linear-server keeps working when the config's server name is swapped to a
 * Kanon-backed `linear-server`. `parity.test.ts` asserts the server's
 * `tools/list` output equals this oracle — drift here is a parity break.
 *
 * Kanon does not model every Linear concept (releases); those args are
 * accepted in the schema for call-site compatibility and ignored or surfaced
 * as unsupported by the handler. Initiatives, status updates, documents, and
 * cycles ARE modelled (other_entities); cycles add the `save_cycle`/`get_cycle`
 * Kanon extensions since Linear's MCP exposes cycles read-only.
 */

export interface ToolSchema {
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, object>;
    required?: string[];
    additionalProperties: false;
  };
}

const str = (description: string) => ({ type: "string", description });
const strArr = (description: string) => ({ type: "array", items: { type: "string" }, description });

export const LINEAR_TOOL_SCHEMAS: Record<string, ToolSchema> = {
  list_issues: {
    description:
      'List issues in the user\'s Linear workspace. For my issues, use "me" as the assignee. Use "null" for no assignee.',
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        assignee: { description: 'User ID, name, email, or "me"' },
        createdAt: str("Created after: ISO-8601 date/duration (e.g., -P1D)"),
        cursor: str("Next page cursor"),
        cycle: str("Cycle name, number, or ID"),
        delegate: str("Agent name or ID"),
        includeArchived: { type: "boolean", default: true, description: "Include archived items" },
        label: str("Label name or ID"),
        limit: {
          type: "number",
          default: 50,
          maximum: 250,
          description: "Max results (default 50, max 250)",
        },
        orderBy: {
          type: "string",
          default: "updatedAt",
          enum: ["createdAt", "updatedAt"],
          description: "Sort: createdAt | updatedAt",
        },
        parentId: str("Parent issue ID or identifier (e.g., LIN-123)"),
        priority: { type: "number", description: "0=None, 1=Urgent, 2=High, 3=Medium, 4=Low" },
        project: str("Project name, ID, or slug"),
        query: str("Search issue title or description"),
        state: str("State type, name, or ID"),
        team: str("Team name or ID"),
        updatedAt: str("Updated after: ISO-8601 date/duration (e.g., -P1D)"),
      },
    },
  },
  get_issue: {
    description:
      "Retrieve detailed information about an issue by ID, including attachments and git branch name",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: str("Issue ID or identifier (e.g., LIN-123)"),
        includeRelations: {
          type: "boolean",
          default: false,
          description: "Include blocking/related/duplicate relations",
        },
      },
    },
  },
  save_issue: {
    description:
      "Create or update a Linear issue. If `id` is provided, updates the existing issue; otherwise creates a new one. When creating, `title` and `team` are required. Note: use `assignee` (not `assigneeId`) to set the assignee.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: str(
          "Only for updating an existing issue. Pass the issue ID or identifier (e.g., LIN-123).",
        ),
        title: str("Issue title (required when creating)"),
        team: str("Team name or ID (required when creating)"),
        description: str("Content as Markdown."),
        assignee: { description: 'User ID, name, email, or "me". Null to remove' },
        delegate: { description: "Agent name or ID. Null to remove" },
        state: str("State type, name, or ID"),
        priority: { type: "number", description: "0=None, 1=Urgent, 2=High, 3=Medium, 4=Low" },
        estimate: { description: "Issue estimate value." },
        labels: strArr("Label names or IDs"),
        project: { description: "Project name, ID, or slug. Null to remove" },
        milestone: str("Milestone name or ID"),
        parentId: { description: "Parent issue ID or identifier (e.g., LIN-123). Null to remove" },
        blocks: strArr("Issue IDs/identifiers this blocks. Append-only."),
        blockedBy: strArr("Issue IDs/identifiers blocking this. Append-only."),
        relatedTo: strArr("Related issue IDs/identifiers. Append-only."),
        removeBlocks: strArr("Issue IDs/identifiers to stop blocking"),
        removeBlockedBy: strArr("Issue IDs/identifiers to remove as blockers of this issue"),
        removeRelatedTo: strArr("Related issue IDs/identifiers to remove"),
        dueDate: str("Due date (ISO format)"),
      },
    },
  },
  list_teams: {
    description: "List teams in the user's Linear workspace",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        cursor: str("Next page cursor"),
        includeArchived: { type: "boolean", default: false, description: "Include archived items" },
        limit: {
          type: "number",
          default: 50,
          maximum: 250,
          description: "Max results (default 50, max 250)",
        },
        orderBy: {
          type: "string",
          default: "updatedAt",
          enum: ["createdAt", "updatedAt"],
          description: "Sort: createdAt | updatedAt",
        },
        query: str("Search query"),
      },
    },
  },
  get_team: {
    description: "Retrieve details of a specific Linear team",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: { query: str("Team name or ID") },
    },
  },
  list_projects: {
    description: "List projects in the user's Linear workspace",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        cursor: str("Next page cursor"),
        includeArchived: { type: "boolean", default: false, description: "Include archived items" },
        limit: {
          type: "number",
          default: 50,
          maximum: 50,
          description: "Max results (default 50, max 50)",
        },
        orderBy: {
          type: "string",
          default: "updatedAt",
          enum: ["createdAt", "updatedAt"],
          description: "Sort: createdAt | updatedAt",
        },
        query: str("Search project name"),
        team: str("Team name or ID"),
      },
    },
  },
  get_project: {
    description: "Retrieve details of a specific project in Linear",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: { query: str("Project name, ID, or slug") },
    },
  },
  save_project: {
    description:
      "Create or update a Linear project. If `id` is provided, updates the existing project; otherwise creates a new one. When creating, `name` and at least one team are required.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: str("Project ID. If provided, updates the existing project"),
        name: str("Project name (required when creating)"),
        description: str("Content as Markdown."),
        summary: str("Short summary (max 255 chars)"),
        state: str("Project state"),
        targetDate: str("Target date (ISO format)"),
        startDate: str("Start date (ISO format)"),
      },
    },
  },
  list_initiatives: {
    description: "List initiatives in the user's Linear workspace",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        createdAt: str("Created after: ISO-8601 date/duration (e.g., -P1D)"),
        cursor: str("Next page cursor"),
        includeArchived: { type: "boolean", default: false, description: "Include archived items" },
        includeProjects: { type: "boolean", default: false, description: "Include projects" },
        includeSubInitiatives: {
          type: "boolean",
          default: false,
          description: "Include sub-initiatives",
        },
        limit: {
          type: "number",
          default: 50,
          maximum: 250,
          description: "Max results (default 50, max 250)",
        },
        orderBy: {
          type: "string",
          default: "updatedAt",
          enum: ["createdAt", "updatedAt"],
          description: "Sort: createdAt | updatedAt",
        },
        owner: str('User ID, name, email, or "me"'),
        parentInitiative: str("Parent initiative name or ID"),
        query: str("Search initiative name"),
        status: str("Status of the initiative"),
        updatedAt: str("Updated after: ISO-8601 date/duration (e.g., -P1D)"),
      },
    },
  },
  get_initiative: {
    description: "Retrieve detailed information about a specific initiative in Linear",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        includeProjects: { type: "boolean", default: false, description: "Include projects" },
        includeSubInitiatives: {
          type: "boolean",
          default: false,
          description: "Include sub-initiatives",
        },
        query: str("Initiative ID or name"),
      },
    },
  },
  save_initiative: {
    description:
      "Create or update a Linear initiative. If `id` is provided, updates the existing initiative; otherwise creates a new one. When creating, `name` is required.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: str("Initiative ID. If provided, updates the existing initiative"),
        name: str("Initiative name (required when creating)"),
        description: str("Content as Markdown."),
        summary: str("Short summary (max 255 chars)"),
        status: str("Initiative status (Proposed, Planned, Active, Completed, Canceled)"),
        owner: { description: 'User ID, name, email, or "me". Null to remove' },
        priority: {
          type: "integer",
          minimum: 0,
          maximum: 4,
          description: "0=None, 1=Urgent, 2=High, 3=Medium, 4=Low",
        },
        targetDate: str("Target date (ISO format)"),
        color: str("Hex color"),
        icon: str('Icon name or emoji code (e.g. "Rocket" or ":eagle:"), not a raw Unicode emoji'),
        parentInitiatives: {
          type: "array",
          items: { type: "string" },
          description: "Parent initiative names or IDs to add. Appended to existing parents",
        },
      },
    },
  },
  get_status_updates: {
    description:
      "List or get project/initiative status updates. Pass `id` to get a specific update, or filter to list.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["type"],
      properties: {
        type: {
          type: "string",
          enum: ["project", "initiative"],
          description: "Type of status update",
        },
        id: str("Status update ID - if provided, returns this specific update"),
        project: str("Project name, ID, or slug"),
        initiative: str("Initiative name or ID"),
        user: str('User ID, name, email, or "me"'),
        createdAt: str("Created after: ISO-8601 date/duration (e.g., -P1D)"),
        updatedAt: str("Updated after: ISO-8601 date/duration (e.g., -P1D)"),
        cursor: str("Next page cursor"),
        includeArchived: { type: "boolean", default: false, description: "Include archived items" },
        limit: {
          type: "number",
          default: 50,
          maximum: 250,
          description: "Max results (default 50, max 250)",
        },
        orderBy: {
          type: "string",
          default: "updatedAt",
          enum: ["createdAt", "updatedAt"],
          description: "Sort: createdAt | updatedAt",
        },
      },
    },
  },
  save_status_update: {
    description:
      "Create or update a project/initiative status update. Omit `id` to create, provide `id` to update.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["type"],
      properties: {
        type: {
          type: "string",
          enum: ["project", "initiative"],
          description: "Type of status update",
        },
        id: str("Status update ID - if provided, updates this existing update"),
        project: str("Project name, ID, or slug"),
        initiative: str("Initiative name or ID"),
        health: {
          type: "string",
          enum: ["onTrack", "atRisk", "offTrack"],
          description: "onTrack | atRisk | offTrack",
        },
        body: str(
          "Content as Markdown. Do not escape the string — use literal newlines and special characters, not escape sequences. To mention a user, use @displayName (e.g., @johndoe)",
        ),
        isDiffHidden: {
          type: "boolean",
          description: "Deprecated. Hide diff with previous update (create only)",
        },
      },
    },
  },
  list_documents: {
    description: "List documents in the user's Linear workspace",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        projectId: str("Filter by project ID"),
        initiativeId: str("Filter by initiative ID"),
        teamId: str("Filter by team ID"),
        creatorId: str("Filter by creator ID"),
        query: str("Search query"),
        createdAt: str("Created after: ISO-8601 date/duration (e.g., -P1D)"),
        updatedAt: str("Updated after: ISO-8601 date/duration (e.g., -P1D)"),
        cursor: str("Next page cursor"),
        includeArchived: { type: "boolean", default: false, description: "Include archived items" },
        limit: {
          type: "number",
          default: 50,
          maximum: 250,
          description: "Max results (default 50, max 250)",
        },
        orderBy: {
          type: "string",
          default: "updatedAt",
          enum: ["createdAt", "updatedAt"],
          description: "Sort: createdAt | updatedAt",
        },
      },
    },
  },
  get_document: {
    description: "Retrieve a Linear document by ID or slug",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: str("Document ID or slug"),
      },
    },
  },
  save_document: {
    description:
      "Create or update a Linear document. If `id` is provided, updates the existing document; otherwise creates a new one. When creating, `title` is required and exactly one parent (`project`, `issue`, `initiative`, `cycle`, or `team`) must be specified. On update, passing a parent reparents the document.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: str("Document ID or slug to update. Omit to create a new document."),
        title: str("Document title (required when creating)"),
        content: str(
          "Content as Markdown. Do not escape the string — use literal newlines and special characters, not escape sequences. To mention a user, use @displayName (e.g., @johndoe)",
        ),
        project: str("Project name, ID, or slug"),
        issue: str("Issue ID or identifier (e.g., LIN-123)"),
        initiative: str("Initiative name or ID"),
        cycle: str(
          "Cycle name, number, or ID. When passing a name or number, also pass `team` to disambiguate.",
        ),
        team: str(
          "Team name or ID. Attaches the document to the team, unless `cycle` is also passed, in which case it disambiguates the cycle.",
        ),
        color: str("Hex color"),
        icon: str('Icon name or emoji code (e.g. "Rocket" or ":eagle:"), not a raw Unicode emoji'),
      },
    },
  },
  list_comments: {
    description: "List comments on a Linear issue. Provide `issueId`.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        issueId: str("Issue ID or identifier (e.g., LIN-123)"),
        cursor: str("Next page cursor"),
        limit: {
          type: "number",
          default: 50,
          maximum: 250,
          description: "Max results (default 50, max 250)",
        },
        orderBy: {
          type: "string",
          default: "updatedAt",
          enum: ["createdAt", "updatedAt"],
          description: "Sort: createdAt | updatedAt",
        },
      },
    },
  },
  save_comment: {
    description:
      "Create or update a comment on a Linear issue. If `id` is provided, updates the existing comment; otherwise creates a new one. Pass `body` and `issueId` to start a thread, or `parentId` and `body` to reply.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["body"],
      properties: {
        body: str("Content as Markdown."),
        issueId: str("Issue ID or identifier (e.g., LIN-123)"),
        id: str("Comment ID. If provided, updates the existing comment"),
        parentId: str("Parent comment ID (for replies, only when creating)"),
      },
    },
  },
  list_issue_statuses: {
    description: "List available issue statuses in a Linear team",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["team"],
      properties: { team: str("Team name or ID") },
    },
  },
  list_issue_labels: {
    description: "List available issue labels in a Linear workspace or team",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        cursor: str("Next page cursor"),
        limit: {
          type: "number",
          default: 50,
          maximum: 250,
          description: "Max results (default 50, max 250)",
        },
        name: str("Filter by name"),
        orderBy: {
          type: "string",
          default: "updatedAt",
          enum: ["createdAt", "updatedAt"],
          description: "Sort: createdAt | updatedAt",
        },
        team: str("Team name or ID"),
      },
    },
  },
  list_users: {
    description: "Retrieve users in the Linear workspace",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        cursor: str("Next page cursor"),
        limit: {
          type: "number",
          default: 50,
          maximum: 250,
          description: "Max results (default 50, max 250)",
        },
        orderBy: {
          type: "string",
          default: "updatedAt",
          enum: ["createdAt", "updatedAt"],
          description: "Sort: createdAt | updatedAt",
        },
        query: str("Filter by name or email"),
        team: str("Team name or ID"),
      },
    },
  },
  list_cycles: {
    description: "Retrieve cycles for a specific Linear team",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["teamId"],
      properties: {
        teamId: str("Team ID"),
        type: {
          type: "string",
          enum: ["current", "previous", "next"],
          description: "Filter: current, previous, next, or all",
        },
      },
    },
  },
};

export type LinearToolName = keyof typeof LINEAR_TOOL_SCHEMAS;
