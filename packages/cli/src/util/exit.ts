import {
  AdapterError,
  AuthError,
  ConfigError,
  ValidationError,
} from "@pradhankukiran/crashscope-core";

/**
 * Process exit codes the CLI emits.
 *
 * Kept as a const-object plus a derived union so consumers can branch on
 * specific codes without resorting to magic numbers and `process.exit(2)`
 * sprinkled across command files.
 *
 * | Code | Meaning                                                  |
 * | ---- | -------------------------------------------------------- |
 * | 0    | Success                                                  |
 * | 1    | User error (invalid args, malformed config, validation)  |
 * | 2    | Adapter / upstream-API error                             |
 * | 3    | Anthropic auth failure                                   |
 */
export const EXIT_CODES = {
  SUCCESS: 0,
  USER_ERROR: 1,
  ADAPTER_ERROR: 2,
  AUTH_ERROR: 3,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

/**
 * Map an unknown thrown value onto the CLI exit code that best describes it.
 *
 * Order of checks matters: {@link ValidationError} extends {@link CrashscopeError}
 * so we check the narrower type first. Anything that isn't one of our four
 * tagged classes falls through to `USER_ERROR` rather than crashing — the
 * caller's stderr renderer still gets to log the underlying message.
 */
export function exitCodeFor(err: unknown): ExitCode {
  if (err instanceof AuthError) return EXIT_CODES.AUTH_ERROR;
  if (err instanceof AdapterError) return EXIT_CODES.ADAPTER_ERROR;
  if (err instanceof ValidationError) return EXIT_CODES.USER_ERROR;
  if (err instanceof ConfigError) return EXIT_CODES.USER_ERROR;
  // Range errors (e.g. parseSince) and other generic Errors are user-facing.
  if (err instanceof RangeError) return EXIT_CODES.USER_ERROR;
  return EXIT_CODES.USER_ERROR;
}
