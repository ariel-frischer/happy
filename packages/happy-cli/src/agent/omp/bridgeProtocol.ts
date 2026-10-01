/**
 * JSON-lines protocol between the omp `happy-bridge` extension (running inside
 * an interactive omp TUI) and its child process `happy omp-bridge`.
 *
 * One JSON object per line in each direction. The extension mirrors these types
 * in ~/.omp/agent/extensions/happy-bridge.ts; bump the version on any
 * incompatible change.
 */
import { z } from 'zod';

export const OMP_BRIDGE_PROTOCOL_VERSION = 6;

const OmpSessionInfoSchema = z.object({
  cwd: z.string(),
  ompSessionId: z.string(),
  title: z.string().optional(),
});
export type OmpSessionInfo = z.infer<typeof OmpSessionInfoSchema>;

/** One question of omp's `ask` dialog (omp's ExtensionAskDialogQuestion, minus previews). */
const OmpAskQuestionSchema = z.object({
  id: z.string(),
  question: z.string(),
  header: z.string().optional(),
  options: z.array(z.object({ label: z.string(), description: z.string().optional() })),
  multi: z.boolean().optional(),
  /** Index of the recommended option. */
  recommended: z.number().int().optional(),
});
export type OmpAskQuestion = z.infer<typeof OmpAskQuestionSchema>;

/** Answer to one question, as omp's ask dialog returns it. */
const OmpAskAnswerSchema = z.object({
  id: z.string(),
  selectedOptions: z.array(z.string()),
  customInput: z.string().optional(),
});
export type OmpAskAnswer = z.infer<typeof OmpAskAnswerSchema>;

/** omp's ExtensionAskDialogResultItem: what the extension hands back to the ask tool. */
export type OmpAskResultItem = OmpAskAnswer & {
  question: string;
  options: string[];
  multi: boolean;
};

/** omp's ImageContent, minus provider fields: base64 bytes plus MIME type. */
const OmpImageSchema = z.object({ data: z.string(), mimeType: z.string() });
export type OmpImage = z.infer<typeof OmpImageSchema>;

/** A user message typed in the TUI (phone-originated messages are never echoed). */
const UserEventSchema = z.object({ t: z.literal('user'), text: z.string(), images: z.array(OmpImageSchema).optional() });
/** One finished assistant message. */
const AssistantEventSchema = z.object({ t: z.literal('assistant'), text: z.string().optional(), thinking: z.string().optional() });
/** `subtitle` is a short omp-specific summary (task progress, eval language, search query…). */
const ToolStartEventSchema = z.object({ t: z.literal('tool_start'), id: z.string(), name: z.string(), args: z.record(z.string(), z.unknown()), subtitle: z.string().optional() });
/** `output` is the tool's text result, already capped; `images` are image blocks of the result. */
const ToolEndEventSchema = z.object({
  t: z.literal('tool_end'),
  id: z.string(),
  name: z.string(),
  isError: z.boolean(),
  output: z.string().optional(),
  images: z.array(OmpImageSchema).optional(),
});
const StatusEventSchema = z.object({
  t: z.literal('status'),
  status: z.enum(['busy', 'idle']),
  /** How the finished turn ended; only meaningful with `idle`. */
  outcome: z.enum(['completed', 'cancelled', 'failed']).optional(),
  error: z.string().optional(),
  /** omp session entry the session ended the turn on (`idle` only); history resumes after it. */
  leafId: z.string().optional(),
});

/** A background job in omp (async subagent, backgrounded bash/eval); omp's AsyncJob, minus internals. */
const OmpJobSchema = z.object({
  id: z.string(),
  type: z.string(),
  label: z.string(),
  status: z.enum(['running', 'completed', 'failed', 'cancelled']),
  startTime: z.number(),
  endTime: z.number().optional(),
  /** Registered but waiting for a free slot. */
  queued: z.boolean().optional(),
  /** The omp tool call that started the job. */
  toolCallId: z.string().optional(),
});
export type OmpJob = z.infer<typeof OmpJobSchema>;

/** Past conversation replayed into a Happy session: the same events a live turn sends. */
const HistoryEventSchema = z.discriminatedUnion('t', [UserEventSchema, AssistantEventSchema, ToolStartEventSchema, ToolEndEventSchema, StatusEventSchema]);
export type OmpHistoryEvent = z.infer<typeof HistoryEventSchema>;

/** Extension → bridge. */
export const ExtToBridgeSchema = z.discriminatedUnion('t', [
  /**
   * First line; opens the Happy session for the current omp session. `pid` is
   * the omp process: reported to the daemon as the session's hostPid (the
   * `happy` launcher sits between omp and the bridge, so ppid is not omp).
   */
  z.object({ t: z.literal('hello'), v: z.number(), pid: z.number().int(), session: OmpSessionInfoSchema }),
  /**
   * omp switched session (/new, /resume, /fork, branch): mirror the new one,
   * reattaching to its Happy session when it was mirrored before.
   */
  z.object({ t: z.literal('session'), session: OmpSessionInfoSchema }),
  UserEventSchema,
  AssistantEventSchema,
  ToolStartEventSchema,
  /** A tool's subtitle changed (subagent progress), also after it returned while its subagents run on. */
  z.object({ t: z.literal('tool_update'), id: z.string(), name: z.string(), args: z.record(z.string(), z.unknown()), subtitle: z.string() }),
  ToolEndEventSchema,
  /** Answer to `ready.backfill`: omp session history the Happy session lacks, oldest first. */
  z.object({
    t: z.literal('history'),
    events: z.array(HistoryEventSchema),
    /** Older messages left out to bound the replay. */
    omitted: z.number().int(),
    /** Last omp session entry covered. */
    leafId: z.string().optional(),
  }),
  /** Transient busy detail ("Compacting context…"); no `text` clears it. */
  z.object({ t: z.literal('activity'), text: z.string().optional() }),
  StatusEventSchema,
  z.object({ t: z.literal('title'), title: z.string() }),
  /** A one-line note for the app (result of an app `/command`, e.g. the new model). */
  z.object({ t: z.literal('notice'), text: z.string() }),
  /** omp is shutting down: archive the Happy session and exit. */
  z.object({ t: z.literal('end') }),
  /** An `ask` dialog opened in the TUI; show it in the app too. First answer wins. */
  z.object({ t: z.literal('ask'), id: z.string(), toolCallId: z.string().optional(), questions: z.array(OmpAskQuestionSchema) }),
  /**
   * The TUI dialog settled first (or the ask was aborted): close the app form.
   * `answers` is set when the user answered on the laptop.
   */
  z.object({ t: z.literal('ask_cancel'), id: z.string(), answers: z.array(OmpAskAnswerSchema).optional() }),
  /** The running background jobs, plus ones that just ended; sent when the list changes. */
  z.object({ t: z.literal('jobs'), jobs: z.array(OmpJobSchema) }),
  /** A background job ended; `output` is its result or error text, already capped. */
  z.object({ t: z.literal('job_end'), job: OmpJobSchema, output: z.string().optional() }),
]);
export type ExtToBridge = z.infer<typeof ExtToBridgeSchema>;

/** Bridge → extension. */
export type BridgeToExt =
  /**
   * The Happy session is open. `backfill` asks for omp history it does not show
   * yet: everything (new session), or only entries after `afterEntryId` (reattached).
   */
  | { t: 'ready'; v: number; happySessionId: string | null; backfill?: { afterEntryId?: string } }
  /** Message typed in the Happy app; deliver with `pi.sendUserMessage`. */
  | { t: 'user_message'; text: string; images?: OmpImage[] }
  /** Stop button in the app: ends the current turn; background jobs keep running. */
  | { t: 'abort' }
  /** A background job's Stop button in the app. */
  | { t: 'cancel_job'; id: string }
  /** The app answered an `ask` first; resolve the TUI dialog with these results. */
  | { t: 'ask_answer'; id: string; results: OmpAskResultItem[] }
  /** The app dismissed an `ask` form; cancel the TUI dialog too. */
  | { t: 'ask_cancelled'; id: string }
  /** The app archived, deleted, or stopped the session: quit omp. */
  | { t: 'exit'; reason: string }
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
