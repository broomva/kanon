/** Output helpers — `--json` on every read (and write) command. */

export function emit(json: boolean, value: unknown, human: () => void): void {
  if (json) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    human();
  }
}

/** Render a priority for humans: 1=urgent … 4=low, 0/null=none. */
export function priorityLabel(priority: number | null): string {
  switch (priority) {
    case 1:
      return "P1·urgent";
    case 2:
      return "P2·high";
    case 3:
      return "P3·medium";
    case 4:
      return "P4·low";
    default:
      return "—";
  }
}
