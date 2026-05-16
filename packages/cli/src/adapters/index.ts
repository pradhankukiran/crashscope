/**
 * Adapter wiring for the crashscope CLI.
 *
 * The factory here turns a validated {@link CrashscopeConfig} into the two
 * adapter handles the triage flow needs. Keeping this in the CLI (rather than
 * in `@pradhankukiran/crashscope-core`) means the core package stays free of "pick one of
 * these N constructors" coupling.
 */
export { createErrorAdapter, createSessionAdapter } from "./factory.js";
