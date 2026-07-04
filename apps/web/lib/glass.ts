import type { CSSProperties } from "react";

// Next 16's CSS optimiser (Lightning CSS) strips `backdrop-filter` from every
// stylesheet rule, so the vendored .bv-glass* classes lose their frost. Inline
// styles bypass the CSS pipeline entirely — the only reliable way to keep the
// earned-glass surfaces (command palette, dialog, composer) actually blurring
// what's behind them. Values mirror the design tokens (--bv-blur-xl / -lg).
export const glassHeavyBlur: CSSProperties = {
  backdropFilter: "blur(32px) saturate(2)",
  WebkitBackdropFilter: "blur(32px) saturate(2)",
};

export const glassComposerBlur: CSSProperties = {
  backdropFilter: "blur(22px) saturate(1.8)",
  WebkitBackdropFilter: "blur(22px) saturate(1.8)",
};
