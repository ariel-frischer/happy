import { describe, expect, it } from 'vitest';
import { resolveAcpAgentConfig } from './acpAgentConfig';

describe('resolveAcpAgentConfig', () => {
  it('resolves known agent names to predefined command + args', () => {
    expect(resolveAcpAgentConfig(['gemini'])).toEqual({
      agentName: 'gemini',
      command: 'gemini',
      args: ['--experimental-acp'],
    });
  });

  it('runs omp in ACP mode and keeps extra args after the subcommand', () => {
    expect(resolveAcpAgentConfig(['omp', '--yolo'])).toEqual({
      agentName: 'omp',
      command: 'omp',
      args: ['acp', '--yolo'],
    });
  });

  it('appends extra CLI args for known agent aliases', () => {
    expect(resolveAcpAgentConfig(['opencode', '--foo'])).toEqual({
      agentName: 'opencode',
      command: 'opencode',
      args: ['acp', '--foo'],
    });
  });

  it('strips legacy --acp for opencode compatibility', () => {
    expect(resolveAcpAgentConfig(['opencode', '--acp', '--foo'])).toEqual({
      agentName: 'opencode',
      command: 'opencode',
      args: ['acp', '--foo'],
    });
  });

  it('resolves custom command form with -- separator', () => {
    expect(resolveAcpAgentConfig(['--', 'custom-agent', '--flag'])).toEqual({
      agentName: 'custom-agent',
      command: 'custom-agent',
      args: ['--flag'],
    });
  });

  it('treats unknown agent names as direct commands', () => {
    expect(resolveAcpAgentConfig(['my-agent', '--x'])).toEqual({
      agentName: 'my-agent',
      command: 'my-agent',
      args: ['--x'],
    });
  });

  it('throws with helpful usage when no args are provided', () => {
    expect(() => resolveAcpAgentConfig([])).toThrow('Usage: happy acp <agent-name> or happy acp -- <command> [args]');
  });

  it('throws when separator form omits command', () => {
    expect(() => resolveAcpAgentConfig(['--'])).toThrow('Missing command after "--". Usage: happy acp -- <command> [args]');
  });
});
