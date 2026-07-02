/**
 * Strict argument parsing for the kanon CLI — same discipline as the
 * linear-import CLI: unknown flags, missing values, boolean flags given a
 * value, and stray positionals are hard errors, never silently ignored
 * (a `--dryrun` typo must not silently mutate the log).
 */

/** A user-input error: index.ts prints the message and exits 1. */
export class CliError extends Error {}

export type FlagKind = "boolean" | "value" | "repeated";

/** flag name → kind. */
export type FlagSpec = Record<string, FlagKind>;

export type FlagValue = string | boolean | string[];

export interface ParsedArgs {
  positionals: string[];
  flags: Map<string, FlagValue>;
}

export interface PositionalSpec {
  min: number;
  max: number;
  usage: string;
}

export function parseFlags(
  argv: string[],
  spec: FlagSpec,
  positionalSpec: PositionalSpec,
): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, FlagValue>();

  const setValue = (name: string, kind: FlagKind, value: string): void => {
    if (kind === "repeated") {
      const current = flags.get(name);
      if (Array.isArray(current)) {
        current.push(value);
      } else {
        flags.set(name, [value]);
      }
      return;
    }
    if (flags.has(name)) {
      throw new CliError(`--${name} given more than once`);
    }
    flags.set(name, value);
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    const name = eq === -1 ? body : body.slice(0, eq);
    const inline = eq === -1 ? undefined : body.slice(eq + 1);
    const kind = spec[name];
    if (kind === undefined) {
      throw new CliError(`unknown flag: --${name}`);
    }
    if (kind === "boolean") {
      if (inline !== undefined) {
        throw new CliError(`--${name} does not take a value`);
      }
      flags.set(name, true);
      continue;
    }
    if (inline !== undefined) {
      if (inline.length === 0) throw new CliError(`--${name} requires a value`);
      setValue(name, kind, inline);
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new CliError(`--${name} requires a value`);
    }
    setValue(name, kind, next);
    i++;
  }

  if (positionals.length < positionalSpec.min || positionals.length > positionalSpec.max) {
    throw new CliError(`usage: ${positionalSpec.usage}`);
  }
  return { positionals, flags };
}

export function flagString(flags: Map<string, FlagValue>, name: string): string | undefined {
  const value = flags.get(name);
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new CliError(`--${name} requires a value`);
  return value;
}

export function requireFlag(flags: Map<string, FlagValue>, name: string): string {
  const value = flagString(flags, name);
  if (value === undefined) throw new CliError(`missing required flag: --${name}`);
  return value;
}

export function flagBool(flags: Map<string, FlagValue>, name: string): boolean {
  return flags.get(name) === true;
}

export function flagStrings(flags: Map<string, FlagValue>, name: string): string[] {
  const value = flags.get(name);
  if (value === undefined) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return [value];
  throw new CliError(`--${name} requires a value`);
}

export function flagInt(
  flags: Map<string, FlagValue>,
  name: string,
  min: number,
  max: number,
): number | undefined {
  const raw = flagString(flags, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new CliError(`--${name} must be an integer between ${min} and ${max} (got ${raw})`);
  }
  return value;
}

export function flagNumber(flags: Map<string, FlagValue>, name: string): number | undefined {
  const raw = flagString(flags, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new CliError(`--${name} must be a number (got ${raw})`);
  }
  return value;
}
