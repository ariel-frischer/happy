import type { SpawnSessionOptions } from '@/modules/common/registerCommonHandlers';

export type DaemonSpawnAgent = NonNullable<SpawnSessionOptions['agent']>;

/**
 * CLI argv (after the happy entrypoint) that starts a daemon-owned session.
 * omp normally starts as a tmux TUI (see buildOmpTmuxSpawn); without tmux it
 * falls back to the headless generic ACP runner (`happy acp omp`), which
 * forwards every argument except `--started-by` to the agent process, so it
 * must not receive `--happy-starting-mode`.
 */
export function buildDaemonAgentLaunchArgs(agent: DaemonSpawnAgent): string[] {
  if (agent === 'omp') {
    return ['acp', 'omp', '--started-by', 'daemon'];
  }
  return [agent, '--happy-starting-mode', 'remote', '--started-by', 'daemon'];
}

export type OmpTmuxSpawn = {
  /** tmux session name; the laptop attaches with `tmux attach -t <name>`. */
  sessionName: string;
  /** argv for `tmux` (run without a shell). Prints the pane pid on stdout. */
  tmuxArgs: string[];
};

/**
 * Phone-started omp runs as the interactive TUI in its own detached tmux
 * session, mirrored by the omp `happy-bridge` extension (`happy omp-bridge`),
 * so the laptop can attach to the same live process. `exec` keeps the pane pid
 * equal to omp's pid, which the bridge reports as `hostPid` so the daemon's
 * spawn awaiter resolves with the bridge's Happy session id.
 */
export function buildOmpTmuxSpawn(opts: {
  directory: string;
  env: Record<string, string>;
  /** Session-scoped variables the tmux server environment may carry stale. */
  unsetKeys: string[];
  suffix: string;
}): OmpTmuxSpawn {
  const sessionName = `happy-omp-${opts.suffix}`;
  const env: Record<string, string> = {
    ...opts.env,
    HAPPY_OMP_STARTED_BY: 'daemon',
    OMP_HAPPY_BRIDGE: '1',
  };
  const envArgs = Object.entries(env)
    .filter(([key]) => /^[A-Z_][A-Z0-9_]*$/i.test(key))
    .flatMap(([key, value]) => ['-e', `${key}=${value}`]);
  const unset = opts.unsetKeys.length > 0 ? `unset ${opts.unsetKeys.join(' ')}; ` : '';
  return {
    sessionName,
    tmuxArgs: [
      'new-session', '-d', '-s', sessionName, '-c', opts.directory,
      ...envArgs,
      '-P', '-F', '#{pane_pid}',
      `${unset}exec omp`,
    ],
  };
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