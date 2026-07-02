/**
 * @kanon/store — SQLite projection of the Kanon event log.
 *
 * The log is canonical; this store is a DISPOSABLE cache. Deleting
 * `state.db` and rebuilding is always safe and always correct. Builds are
 * full replays from genesis (no snapshot-resume in v1), so the
 * `ReplayDivergenceError` class of failures cannot occur here.
 */

export * from "./log";
export * from "./projection";
export * from "./queries";
export { PROJECTION_SCHEMA_VERSION } from "./schema";
