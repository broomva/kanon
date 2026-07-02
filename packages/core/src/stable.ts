/**
 * Deterministic serialization + hashing — zero runtime dependencies,
 * platform-neutral (no fs, no Bun-only APIs).
 *
 * Both live here rather than inline in merge/snapshot because merge needs
 * content-identity comparison and snapshot needs checksumming, and the two
 * must agree on what "the same value" means.
 */

/**
 * JSON.stringify with object keys emitted in sorted order at every depth.
 *
 * Intended for plain JSON data (the only thing Kanon events and snapshots
 * carry). Like JSON.stringify: `undefined`, functions, and symbols are
 * omitted from objects and become `null` inside arrays; non-finite numbers
 * become `null`. `toJSON` methods are NOT honored — values are serialized
 * structurally.
 */
export function stableStringify(value: unknown): string {
  return stringifyValue(value) ?? "null";
}

function stringifyValue(value: unknown): string | undefined {
  if (value === null) {
    return "null";
  }
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      return Number.isFinite(value) ? String(value) : "null";
    case "boolean":
      return value ? "true" : "false";
    case "object":
      break;
    default:
      // undefined, function, symbol, bigint — omitted, as JSON.stringify does.
      return undefined;
  }
  if (Array.isArray(value)) {
    const parts = value.map((item) => stringifyValue(item) ?? "null");
    return `[${parts.join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(record).sort()) {
    const piece = stringifyValue(record[key]);
    if (piece !== undefined) {
      parts.push(`${JSON.stringify(key)}:${piece}`);
    }
  }
  return `{${parts.join(",")}}`;
}

const FNV64_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV64_PRIME = 0x100000001b3n;
const U64_MASK = 0xffffffffffffffffn;

/**
 * FNV-1a 64-bit over the UTF-16LE bytes of the input string, returned as
 * 16-char lowercase hex. Inline implementation — no dependencies. This is a
 * convergence checksum, not a cryptographic hash.
 */
export function fnv1a64(input: string): string {
  let hash = FNV64_OFFSET_BASIS;
  for (let i = 0; i < input.length; i++) {
    const unit = input.charCodeAt(i);
    hash ^= BigInt(unit & 0xff);
    hash = (hash * FNV64_PRIME) & U64_MASK;
    hash ^= BigInt(unit >>> 8);
    hash = (hash * FNV64_PRIME) & U64_MASK;
  }
  return hash.toString(16).padStart(16, "0");
}
