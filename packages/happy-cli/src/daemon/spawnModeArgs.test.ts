import { describe, expect, it } from 'vitest';
import { appendDaemonSpawnModeArgs, buildDaemonAgentLaunchArgs, shouldForwardDaemonPermissionMode } from './spawnModeArgs';

describe('daemon agent launch arguments', () => {
  it('starts omp through the ACP runner without flags it would forward to omp', () => {
    expect(buildDaemonAgentLaunchArgs('omp')).toEqual(['acp', 'omp', '--started-by', 'daemon']);
  });

  it('starts dedicated agents in remote mode', () => {
    expect(buildDaemonAgentLaunchArgs('gemini')).toEqual(['gemini', '--happy-starting-mode', 'remote', '--started-by', 'daemon']);
  });
});

describe('daemon spawn mode arguments', () => {
  it('forwards Codex default because it is a concrete ask-first policy', () => {
    const args: string[] = [];

    appendDaemonSpawnModeArgs(args, { directory: '/repo', permissionMode: 'default' }, 'codex');

    expect(args).toEqual(['--permission-mode', 'default']);
  });

  it('leaves Claude default ambient', () => {
    const args: string[] = [];

    appendDaemonSpawnModeArgs(args, { directory: '/repo', permissionMode: 'default' }, 'claude');

    expect(args).toEqual([]);
  });

  it('forwards explicit Codex permission, model, and effort selections', () => {
    const args: string[] = [];

    appendDaemonSpawnModeArgs(args, {
      directory: '/repo',
      permissionMode: 'yolo',
      modelMode: 'gpt-5.6-sol',
      effortLevel: 'medium',
    }, 'codex');

    expect(args).toEqual([
      '--permission-mode', 'yolo',
      '--model', 'gpt-5.6-sol',
      '--effort', 'medium',
    ]);
  });

  it('uses the same Codex default rule for resume launches', () => {
    expect(shouldForwardDaemonPermissionMode('codex', 'default')).toBe(true);
    expect(shouldForwardDaemonPermissionMode('claude', 'default')).toBe(false);
  });
});