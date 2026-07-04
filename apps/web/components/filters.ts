import type { Bucket } from "../lib/work-state";

export interface Filters {
  team?: string;
  project?: string;
  /** State-type bucket filter, driven by the plane chips. */
  bucket?: Bucket;
  query?: string;
}

export function filtersEqual(a: Filters, b: Filters): boolean {
  return (
    a.team === b.team && a.project === b.project && a.bucket === b.bucket && a.query === b.query
  );
}
