// The work-state model — the design system's plain-voice vocabulary is canon.
// Kanon carries Linear-style workflow states (triage/backlog/unstarted/started/
// completed/canceled); we collapse those into the four calm buckets a human
// reads, and drive colour from the design tones (gray / info / success), never
// the raw Linear hex — Broomva runs monochrome on a blue axis.

export type Tone = "muted" | "info" | "success" | "warning" | "accent";

export type Bucket = "queued" | "started" | "done" | "canceled";

export interface BucketMeta {
  id: Bucket;
  /** Plain voice, sentence case. */
  label: string;
  tone: Tone;
  hint: string;
  /** The Linear state types that fall into this bucket. */
  stateTypes: string[];
}

const QUEUED: BucketMeta = {
  id: "queued",
  label: "Queued",
  tone: "muted",
  hint: "Waiting for a hand",
  stateTypes: ["triage", "backlog", "unstarted"],
};
const STARTED: BucketMeta = {
  id: "started",
  label: "In progress",
  tone: "info",
  hint: "Being worked",
  stateTypes: ["started"],
};
const DONE: BucketMeta = {
  id: "done",
  label: "Done",
  tone: "success",
  hint: "The branch is the receipt",
  stateTypes: ["completed"],
};
const CANCELED: BucketMeta = {
  id: "canceled",
  label: "Canceled",
  tone: "muted",
  hint: "Set aside",
  stateTypes: ["canceled"],
};

// Board column order.
export const BUCKETS: BucketMeta[] = [QUEUED, STARTED, DONE, CANCELED];

const TYPE_TO_BUCKET = new Map<string, Bucket>();
for (const bucket of BUCKETS) {
  for (const type of bucket.stateTypes) TYPE_TO_BUCKET.set(type, bucket.id);
}

export function bucketOf(stateType: string | null | undefined): Bucket {
  if (!stateType) return "queued";
  return TYPE_TO_BUCKET.get(stateType) ?? "queued";
}

export function bucketMeta(id: Bucket): BucketMeta {
  return BUCKETS.find((b) => b.id === id) ?? QUEUED;
}

export function toneVar(tone: Tone): string {
  switch (tone) {
    case "info":
      return "var(--bv-info)";
    case "success":
      return "var(--bv-success)";
    case "warning":
      return "var(--bv-warning)";
    case "accent":
      return "var(--bv-blue-accent)";
    default:
      return "var(--bv-gray-400)";
  }
}

// -- priority -----------------------------------------------------------------

export interface PriorityMeta {
  value: number;
  label: string;
  tone: Tone;
}

const NO_PRIORITY: PriorityMeta = { value: 0, label: "No priority", tone: "muted" };

export const PRIORITIES: PriorityMeta[] = [
  NO_PRIORITY,
  { value: 1, label: "Urgent", tone: "warning" },
  { value: 2, label: "High", tone: "info" },
  { value: 3, label: "Medium", tone: "muted" },
  { value: 4, label: "Low", tone: "muted" },
];

export function priorityMeta(value: number | null | undefined): PriorityMeta {
  return PRIORITIES.find((p) => p.value === (value ?? 0)) ?? NO_PRIORITY;
}
