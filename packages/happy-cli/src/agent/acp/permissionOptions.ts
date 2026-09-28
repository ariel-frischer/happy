/**
 * Chooses which ACP permission option answers a Happy permission decision.
 *
 * Agents label their options differently: Gemini offers `proceed_once` /
 * `proceed_always` / `cancel`, while omp and other spec-following agents offer
 * options whose `kind` is `allow_once` / `allow_always` / `reject_once` /
 * `reject_always`. The ACP `optionId` must be one the agent offered.
 */

export type AcpPermissionOption = {
  optionId?: string;
  name?: string;
  kind?: string;
};

export type AcpPermissionDecision = 'approved' | 'approved_for_session' | 'denied' | 'abort';

export function selectPermissionOptionId(
  options: AcpPermissionOption[],
  decision: AcpPermissionDecision,
): string {
  if (decision === 'approved' || decision === 'approved_for_session') {
    // Never let a name heuristic ("Reject once", "Reject always") pick a denial.
    const allowOptions = options.filter((opt) => !opt.kind?.startsWith('reject'));
    const once = allowOptions.find((opt) =>
      opt.optionId === 'proceed_once' || opt.name?.toLowerCase().includes('once'),
    ) ?? allowOptions.find((opt) => opt.kind === 'allow_once');
    const always = allowOptions.find((opt) =>
      opt.optionId === 'proceed_always' || opt.name?.toLowerCase().includes('always'),
    ) ?? allowOptions.find((opt) => opt.kind === 'allow_always');

    if (decision === 'approved_for_session' && always) {
      return always.optionId || 'proceed_always';
    }
    if (once) {
      return once.optionId || 'proceed_once';
    }
    const first = allowOptions[0] ?? options[0];
    if (first) {
      return first.optionId || 'proceed_once';
    }
    return 'cancel';
  }

  // Denied or aborted: agents that offer an explicit cancel keep getting it.
  const cancel = options.find((opt) =>
    opt.optionId === 'cancel' || opt.name?.toLowerCase().includes('cancel'),
  );
  if (cancel) {
    return cancel.optionId || 'cancel';
  }
  const rejectOnce = options.find((opt) => opt.kind === 'reject_once' || opt.optionId === 'reject_once');
  return rejectOnce?.optionId || 'cancel';
}
