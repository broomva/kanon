// First-paint skeletons — matte shimmer that mirrors the real board / list /
// detail so the shell arrives with shape, not a flash of empty columns or a
// bare "Loading…". Purely decorative, so the whole tree is aria-hidden and the
// live region announces load separately.

// Deterministic per-column card counts (no Math.random — keeps SSR stable).
const COLUMN_CARDS = [3, 2, 2, 1];

function Bar({ w, h = 11 }: { w: number | string; h?: number }) {
  return <span className="k-skeleton" style={{ width: w, height: h }} />;
}

export function BoardSkeleton() {
  return (
    <div className="k-board" aria-hidden>
      {COLUMN_CARDS.map((count, col) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length static skeleton
        <div key={col} className="k-col">
          <div className="k-col-head">
            <Bar w={70} h={12} />
          </div>
          <div className="k-col-body">
            {Array.from({ length: count }).map((_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length static skeleton
              <div key={i} className="k-skel-card">
                <Bar w="38%" h={9} />
                <Bar w="85%" h={12} />
                <Bar w="55%" h={9} />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function ListSkeleton() {
  return (
    <div className="k-list" aria-hidden>
      {Array.from({ length: 8 }).map((_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length static skeleton
        <div key={i} className="k-skel-row">
          <span className="k-skeleton" style={{ width: 8, height: 8, borderRadius: 99 }} />
          <Bar w={54} h={10} />
          <span style={{ flex: 1 }}>
            <Bar w={`${55 + ((i * 7) % 35)}%`} h={11} />
          </span>
          <Bar w={40} h={9} />
        </div>
      ))}
    </div>
  );
}

export function DetailSkeleton() {
  return (
    <aside className="k-detail" aria-hidden>
      <div className="k-detail-head">
        <div className="k-detail-crumbs">
          <Bar w={120} h={11} />
        </div>
        <div className="k-skel-block" style={{ marginTop: 14 }}>
          <Bar w="70%" h={20} />
          <Bar w="90%" h={12} />
          <Bar w="45%" h={12} />
        </div>
      </div>
      <div className="k-detail-body">
        <div className="k-skel-block">
          <Bar w="100%" h={12} />
          <Bar w="95%" h={12} />
          <Bar w="60%" h={12} />
        </div>
      </div>
    </aside>
  );
}
