import { describe, expect, it } from 'vitest';
import { parseExtToBridgeLine } from './bridgeProtocol';
import { ompConfigMetadata } from './ompConfigMetadata';

const configOf = (line: string) => {
  const event = parseExtToBridgeLine(line);
  if (event?.t !== 'config') throw new Error(`not a config event: ${line}`);
  return event;
};

describe('ompConfigMetadata', () => {
  it('publishes the current model and thinking level as the current catalog rows', () => {
    const config = configOf('{"t":"config","model":{"code":"anthropic/claude-opus-5-5","name":"Opus 5.5"},"thinkingLevel":"high"}');
    expect(ompConfigMetadata(config)).toEqual({
      models: [{ code: 'anthropic/claude-opus-5-5', value: 'Opus 5.5' }],
      currentModelCode: 'anthropic/claude-opus-5-5',
      thoughtLevels: [{ code: 'high', value: 'high' }],
      currentThoughtLevelCode: 'high',
    });
  });

  it('offers every level the model accepts, so the app can switch between them', () => {
    const config = configOf('{"t":"config","thinkingLevel":"medium","thinkingLevels":["off","low","medium","high"]}');
    expect(ompConfigMetadata(config)).toMatchObject({
      thoughtLevels: [
        { code: 'off', value: 'off' },
        { code: 'low', value: 'low' },
        { code: 'medium', value: 'medium' },
        { code: 'high', value: 'high' },
      ],
      currentThoughtLevelCode: 'medium',
    });
  });

  it('clears a previously reported model and level that omp no longer reports', () => {
    const before = { path: '/repo', ...ompConfigMetadata(configOf('{"t":"config","model":{"code":"a/b","name":"B"},"thinkingLevel":"low"}')) };
    const after = JSON.parse(JSON.stringify({ ...before, ...ompConfigMetadata(configOf('{"t":"config"}')) }));
    expect(after).toEqual({ path: '/repo' });
  });
});
