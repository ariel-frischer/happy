import type { NewSessionAgentType } from '@/sync/persistence';

/**
 * The coding agents Happy can start a session with, and what to call them in
 * the UI. `rig` is the wire/CLI id of Happy's own agent; it is only ever shown
 * as "Happy". `agy` is Antigravity's binary name for the same reason, and
 * `omp` is Oh My Pi's.
 */
export const HARNESS_NAMES: Record<NewSessionAgentType, string> = {
    omp: 'Oh My Pi',
    claude: 'Claude Code',
    codex: 'Codex',
    rig: 'Happy',
    agy: 'Antigravity',
    gemini: 'Gemini',
    openclaw: 'OpenClaw',
};

/**
 * Harnesses you can no longer start a session with.
 *
 * Gemini's CLI login is dead for individual accounts — it now refuses with
 * "This client is no longer supported […] migrate to the Antigravity suite",
 * which is the `agy` harness. OpenClaw is shelved for now. Both stay in
 * HARNESS_NAMES so an existing session still shows a real product name, and
 * neither is removed from the CLI, the wire, or the transcript renderers.
 */
export const RETIRED_HARNESSES: ReadonlySet<NewSessionAgentType> = new Set([
    'gemini',
    'openclaw',
]);

/**
 * The harness a new session starts with until someone picks another. This
 * fork runs Oh My Pi first; a machine that does not report it installed falls
 * through to the next harness in HARNESS_ORDER.
 */
export const DEFAULT_HARNESS: NewSessionAgentType = 'omp';

/** Pick order for every harness list: the ones people reach for come first. */
export const HARNESS_ORDER: readonly NewSessionAgentType[] = [
    'omp',
    'claude',
    'codex',
    'agy',
    'rig',
];

export function isRetiredHarness(key: NewSessionAgentType | string): boolean {
    return RETIRED_HARNESSES.has(key as NewSessionAgentType);
}

/**
 * Harnesses offered only after the machine's daemon reports them installed.
 * Antigravity is niche enough that an old or incomplete capability report must
 * not advertise it speculatively. A daemon too old to report omp also cannot
 * spawn it, so omp needs the same explicit report.
 */
const REPORT_REQUIRED_HARNESSES: ReadonlySet<NewSessionAgentType> = new Set([
    'agy',
    'omp',
]);

export function requiresInstallReport(key: NewSessionAgentType | string): boolean {
    return REPORT_REQUIRED_HARNESSES.has(key as NewSessionAgentType);
}

export type HarnessAvailability = Partial<Record<NewSessionAgentType, boolean>>;

export type HarnessOption = {
    key: NewSessionAgentType;
    name: string;
};

export function getHarnessName(key: NewSessionAgentType | string): string {
    return HARNESS_NAMES[key as NewSessionAgentType] ?? key;
}

/** Whether this machine has given the app enough evidence to offer a harness. */
export function isHarnessAvailable({
    availability,
    happyAgentAvailable,
    key,
}: {
    availability?: HarnessAvailability | null;
    happyAgentAvailable: boolean;
    key: NewSessionAgentType;
}): boolean {
    if (key === 'rig') return happyAgentAvailable;
    if (requiresInstallReport(key)) return availability?.[key] === true;
    return !availability || availability[key] === true;
}

/**
 * The harnesses a machine actually has set up, in pick order.
 *
 * A harness with no CLI on the machine is left out rather than shown disabled:
 * a greyed-out row reads as something you can turn on from here, and you
 * cannot. Two things keep the list from ever being empty — the current
 * selection is usually included, and a machine that reports no capabilities at
 * all (an older daemon, or none selected yet) falls back to the familiar
 * catalog. Antigravity and omp are the exception to both fallbacks: they are
 * only listed after an explicit installation report. A retired harness is also exempt from
 * the first rule, because keeping it listed would strand someone on it.
 */
export function listAvailableHarnesses({
    availability,
    happyAgentAvailable,
    selected,
}: {
    availability?: HarnessAvailability | null;
    happyAgentAvailable: boolean;
    selected?: NewSessionAgentType | null;
}): HarnessOption[] {
    const keys = HARNESS_ORDER.filter((key) => (
        (key === selected && !requiresInstallReport(key))
        || isHarnessAvailable({ availability, happyAgentAvailable, key })
    ));
    const fallback = HARNESS_ORDER.filter((key) => !requiresInstallReport(key));
    return (keys.length > 0 ? keys : fallback).map((key) => ({
        key,
        name: HARNESS_NAMES[key],
    }));
}
