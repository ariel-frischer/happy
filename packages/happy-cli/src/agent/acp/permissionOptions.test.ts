import { describe, expect, it } from 'vitest';

import { selectPermissionOptionId, type AcpPermissionOption } from './permissionOptions';

// omp offers spec kinds with optionId === kind.
const omp: AcpPermissionOption[] = [
  { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'reject_once', name: 'Reject once', kind: 'reject_once' },
  { optionId: 'reject_always', name: 'Always reject', kind: 'reject_always' },
];

// Gemini offers a cancel option for denial.
const gemini: AcpPermissionOption[] = [
  { optionId: 'proceed_once', name: 'Allow', kind: 'allow_once' },
  { optionId: 'proceed_always', name: 'Allow always', kind: 'allow_always' },
  { optionId: 'cancel', name: 'Cancel', kind: 'reject_once' },
];

describe('selectPermissionOptionId', () => {
  it('denies omp with reject_once, never an always option', () => {
    expect(selectPermissionOptionId(omp, 'denied')).toBe('reject_once');
    expect(selectPermissionOptionId(omp, 'abort')).toBe('reject_once');
  });

  it('approves omp once or for the session with the matching allow option', () => {
    expect(selectPermissionOptionId(omp, 'approved')).toBe('allow_once');
    expect(selectPermissionOptionId(omp, 'approved_for_session')).toBe('allow_always');
  });

  it('does not let a reject option named "always" win a session approval', () => {
    const rejectFirst = [omp[3], omp[2], omp[1], omp[0]];
    expect(selectPermissionOptionId(rejectFirst, 'approved_for_session')).toBe('allow_always');
    expect(selectPermissionOptionId(rejectFirst, 'approved')).toBe('allow_once');
  });

  it('keeps sending cancel to agents that offer it', () => {
    expect(selectPermissionOptionId(gemini, 'denied')).toBe('cancel');
    expect(selectPermissionOptionId(gemini, 'approved')).toBe('proceed_once');
    expect(selectPermissionOptionId(gemini, 'approved_for_session')).toBe('proceed_always');
  });

  it('falls back to cancel when the agent offers no denial option', () => {
    expect(selectPermissionOptionId([{ optionId: 'ok', name: 'OK', kind: 'allow_once' }], 'denied')).toBe('cancel');
  });
});
