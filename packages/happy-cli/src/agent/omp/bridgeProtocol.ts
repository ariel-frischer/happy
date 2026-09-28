/**
 * JSON-lines protocol between the omp `happy-bridge` extension (running inside
 * an interactive omp TUI) and its child process `happy omp-bridge`.
 *
 * One JSON object per line in each direction. The extension mirrors these types
 * in ~/.omp/agent/extensions/happy-bridge.ts; bump the version on any
 * incompatible change.
 */
import { z } from 'zod';

export const OMP_BRIDGE_PROTOCOL_VERSION = 1;

const OmpSessionInfoSchema = z.object({
  cwd: z.string(),
  ompSessionId: z.string(),
  title: z.string().optional(),
});
export type OmpSessionInfo = z.infer<typeof OmpSessionInfoSchema>;

/** Extension → bridge. */
export const ExtToBridgeSchema = z.discriminatedUnion('t', [
  /**
   * First line; opens the Happy session for the current omp session. `pid` is
   * the omp process: reported to the daemon as the session's hostPid (the
   * `happy` launcher sits between omp and the bridge, so ppid is not omp).
   */
  z.object({ t: z.literal('hello'), v: z.number(), pid: z.number().int(), session: OmpSessionInfoSchema }),
  /** omp switched session (/new, /resume, /fork, branch): rotate the Happy session. */
  z.object({ t: z.literal('session'), session: OmpSessionInfoSchema }),
  /** A user message typed in the TUI (phone-originated messages are never echoed). */
  z.object({ t: z.literal('user'), text: z.string() }),
  /** One finished assistant message. */
  z.object({ t: z.literal('assistant'), text: z.string().optional(), thinking: z.string().optional() }),
  z.object({ t: z.literal('tool_start'), id: z.string(), name: z.string(), args: z.record(z.string(), z.unknown()) }),
  z.object({ t: z.literal('tool_end'), id: z.string(), name: z.string(), isError: z.boolean() }),
  z.object({
    t: z.literal('status'),
    status: z.enum(['busy', 'idle']),
    /** How the finished turn ended; only meaningful with `idle`. */
    outcome: z.enum(['completed', 'cancelled', 'failed']).optional(),
    error: z.string().optional(),
  }),
  z.object({ t: z.literal('title'), title: z.string() }),
  /** omp is shutting down: archive the Happy session and exit. */
  z.object({ t: z.literal('end') }),
]);
export type ExtToBridge = z.infer<typeof ExtToBridgeSchema>;

/** Bridge → extension. */
export type BridgeToExt =
  | { t: 'ready'; v: number; happySessionId: string | null }
  /** Message typed in the Happy app; deliver with `pi.sendUserMessage`. */
  | { t: 'user_message'; text: string }
  /** Stop button in the app. */
  | { t: 'abort' }
  /** The app archived/killed the mirror; omp keeps running unmirrored until the next session switch. */
  | { t: 'detached'; reason: string }
  | { t: 'error'; message: string; fatal: boolean };

export function parseExtToBridgeLine(line: string): ExtToBridge | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const parsed = ExtToBridgeSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
