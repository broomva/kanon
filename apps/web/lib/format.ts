// Small formatting helpers. Voice: plain, second-person, sentence case.

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diff = Date.now() - then;
  const sec = Math.round(diff / 1000);
  if (sec < 45) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mon = Math.round(day / 30);
  if (mon < 12) return `${mon}mo ago`;
  return `${Math.round(mon / 12)}y ago`;
}

// A deterministic avatar tint from a name — cool axis only, no warm hues.
export function avatarColor(seed: string | null | undefined): string {
  const s = seed ?? "?";
  let hash = 0;
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) | 0;
  // Keep hue in the blue → indigo → cyan arc (210–285), matching the brand.
  const hue = 210 + (Math.abs(hash) % 75);
  return `oklch(0.62 0.11 ${hue})`;
}

export function initials(name: string | null | undefined): string {
  const n = (name ?? "").trim();
  if (!n) return "·";
  const parts = n.split(/\s+/);
  if (parts.length === 1) return (parts[0] ?? "").slice(0, 2).toUpperCase();
  return ((parts[0]?.[0] ?? "") + (parts[parts.length - 1]?.[0] ?? "")).toUpperCase();
}

const RELATION_VERB: Record<string, string> = {
  blocks: "blocks",
  blocked_by: "blocked by",
  related: "related to",
  duplicate: "duplicate of",
  duplicate_of: "duplicate of",
};

export function relationVerb(relType: string | null | undefined): string {
  if (!relType) return "linked to";
  return RELATION_VERB[relType] ?? relType.replace(/_/g, " ");
}
