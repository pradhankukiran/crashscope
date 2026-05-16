/**
 * @pradhankukiran/crashscope-core — types, Zod schemas, adapter interfaces, and error
 * classes shared by every other crashscope package.
 *
 * This package has no runtime dependencies beyond `zod`. Keep it that way:
 * adapter implementations, CLI, and integrations should depend on `core`,
 * never the other way around.
 */
export * from "./types/index.js";
export * from "./errors.js";
export * from "./agent/index.js";
export * from "./adapters/index.js";
