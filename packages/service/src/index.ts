/**
 * @kanon/service — the service core.
 *
 * Every protocol adapter (the REST rendezvous server, the MCP server) is a
 * thin shell over `KanonService`: the ONE funnel through which reads hit the
 * disposable SQLite projection and writes flow
 *
 *   validation → createEvent → appendEvents (appendFileSync) → git commit
 *   (+push) → projection refresh → in-process bus broadcast
 *
 * Adapters translate their wire protocol to/from these method calls and
 * never re-implement the log/allocation/durability rules — those live here
 * and in @kanon/store, so REST and MCP writes are byte-for-byte the same
 * events in the same canonical log.
 */

export * from "./bus";
export * from "./git";
export * from "./service";
