import type { SpawnSessionOptions } from '@/modules/common/registerCommonHandlers';

export type DaemonSpawnAgent = NonNullable<SpawnSessionOptions['agent']>;

/**
 * CLI argv (after the happy entrypoint) that starts a daemon-owned session.
 * omp has no dedicated subcommand; it runs through the generic ACP runner
 * (`happy acp omp`), which forwards every argument except `--started-by`
 * to the agent process, so it must not receive `--happy-starting-mode`.
 */
export function buildDaemonAgentLaunchArgs(agent: DaemonSpawnAgent): string[] {
  if (agent === 'omp') {
    return ['acp', 'omp', '--started-by', 'daemon'];
  }
  return [agent, '--happy-starting-mode', 'remote', '--started-by', 'daemon'];
}

export function shouldForwardDaemonPermissionMode(
  agent: string,
  permissionMode: string | undefined,
): permissionMode is string {
  if (!permissionMode) return false;

  // Claude's "default" means no harness override. Codex's "default" is a
  // concrete ask-first execution policy and differs from its ambient "auto".
  return permissionMode !== 'default' || agent === 'codex';
}

export function appendDaemonSpawnModeArgs(
  args: string[],
  options: SpawnSessionOptions,
  agent: string,
): void {
  if (agent !== 'claude' && agent !== 'codex') return;

  if (shouldForwardDaemonPermissionMode(agent, options.permissionMode)) {
    args.push('--permission-mode', options.permissionMode);
  }
  if (options.modelMode && options.modelMode !== 'default') {
    args.push('--model', options.modelMode);
  }
  if (options.effortLevel) {
    args.push('--effort', options.effortLevel);
  }
}