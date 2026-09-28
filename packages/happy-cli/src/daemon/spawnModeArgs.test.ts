import { describe, expect, it } from 'vitest';
import { appendDaemonSpawnModeArgs, buildDaemonAgentLaunchArgs, buildOmpTmuxSpawn, shouldForwardDaemonPermissionMode } from './spawnModeArgs';

describe('daemon agent launch arguments', () => {
  it('starts omp through the ACP runner without flags it would forward to omp', () => {
    expect(buildDaemonAgentLaunchArgs('omp')).toEqual(['acp', 'omp', '--started-by', 'daemon']);
  });

  it('starts dedicated agents in remote mode', () => {
    expect(buildDaemonAgentLaunchArgs('gemini')).toEqual(['gemini', '--happy-starting-mode', 'remote', '--started-by', 'daemon']);
  });
});

describe('omp tmux spawn', () => {
  it('starts the omp TUI in its own detached tmux session and reports the pane pid', () => {
    const spawn = buildOmpTmuxSpawn({
      directory: '/work/repo',
      env: { PATH: '/bin', TOKEN: 'a "quoted" $value' },
      unsetKeys: ['CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID'],
      suffix: 'a1b2c3',
    });

    expect(spawn.sessionName).toBe('happy-omp-a1b2c3');
    const args = spawn.tmuxArgs;
    expect(args.slice(0, 6)).toEqual(['new-session', '-d', '-s', 'happy-omp-a1b2c3', '-c', '/work/repo']);
    expect(args.slice(-4)).toEqual(['-P', '-F', '#{pane_pid}', 'unset CLAUDE_CODE_SESSION_ID CODEX_THREAD_ID; exec omp']);
    // argv, not a shell string: values pass through verbatim.
    expect(args).toContain('TOKEN=a "quoted" $value');
    // The bridge must know the daemon owns this session, and must not be opted out.
    expect(args).toContain('HAPPY_OMP_STARTED_BY=daemon');
    expect(args).toContain('OMP_HAPPY_BRIDGE=1');
  });

  it('overrides an inherited bridge opt-out and skips invalid env names', () => {
    const { tmuxArgs } = buildOmpTmuxSpawn({
      directory: '/r',
      env: { OMP_HAPPY_BRIDGE: '0', 'BAD-NAME': 'x' },
      unsetKeys: [],
      suffix: 'x',
    });

    expect(tmuxArgs).not.toContain('OMP_HAPPY_BRIDGE=0');
    expect(tmuxArgs).not.toContain('BAD-NAME=x');
    expect(tmuxArgs.at(-1)).toBe('exec omp');
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