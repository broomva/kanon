import type { CSSProperties } from "react";
import { avatarColor, initials } from "../lib/format";
import { type Bucket, bucketMeta, bucketOf, type Tone, toneVar } from "../lib/work-state";

// The running signal at dot scale — the Undertow folded into a 15px circle.
// Only truly-live work (an active agent session) wears it; everything else is
// a flat tone dot.
export function StateDot({
  stateType,
  live = false,
  size = 8,
}: {
  stateType: string | null | undefined;
  live?: boolean;
  size?: number;
}) {
  if (live) {
    return <span className="bv-dot-live" style={{ width: 13, height: 13 }} aria-hidden />;
  }
  const tone = bucketMeta(bucketOf(stateType)).tone;
  return (
    <span
      className="k-dot"
      style={{ width: size, height: size, background: toneVar(tone) }}
      aria-hidden
    />
  );
}

export function ToneDot({ tone, size = 8 }: { tone: Tone; size?: number }) {
  return (
    <span
      className="k-dot"
      style={{ width: size, height: size, background: toneVar(tone) }}
      aria-hidden
    />
  );
}

export function Badge({
  bucket,
  label,
  live = false,
}: {
  bucket: Bucket;
  label: string;
  live?: boolean;
}) {
  const meta = bucketMeta(bucket);
  return (
    <span className="k-badge">
      {live ? (
        <span className="bv-dot-live" style={{ width: 12, height: 12 }} aria-hidden />
      ) : (
        <ToneDot tone={meta.tone} />
      )}
      {label}
    </span>
  );
}

export function Avatar({
  name,
  size = 22,
  kind = "human",
  title,
}: {
  name: string | null | undefined;
  size?: number;
  kind?: "human" | "agent";
  title?: string;
}) {
  const style: CSSProperties = {
    width: size,
    height: size,
    fontSize: Math.round(size * 0.42),
    background: `color-mix(in oklab, ${avatarColor(name)} 22%, var(--card))`,
    color: avatarColor(name),
    borderColor: kind === "agent" ? "var(--bv-blue)" : "transparent",
  };
  return (
    <span
      className={`k-avatar${kind === "agent" ? " k-avatar--agent" : ""}`}
      style={style}
      title={title ?? name ?? undefined}
      aria-hidden
    >
      {initials(name)}
    </span>
  );
}

// A tiny priority glyph — three ascending bars, filled to the level. Urgent is
// a filled ring instead. Monochrome; colour only for urgent/high.
export function PriorityMark({ priority }: { priority: number | null | undefined }) {
  const p = priority ?? 0;
  if (p === 0) return <span className="k-prio k-prio--none" title="No priority" aria-hidden />;
  if (p === 1) {
    return (
      <span className="k-prio k-prio--urgent" title="Urgent" aria-hidden>
        !
      </span>
    );
  }
  const filled = p === 2 ? 3 : p === 3 ? 2 : 1;
  return (
    <span className="k-prio" title={p === 2 ? "High" : p === 3 ? "Medium" : "Low"} aria-hidden>
      {[0, 1, 2].map((i) => (
        <span key={i} className={`k-prio-bar${i < filled ? " is-on" : ""}`} data-h={i} />
      ))}
    </span>
  );
}
