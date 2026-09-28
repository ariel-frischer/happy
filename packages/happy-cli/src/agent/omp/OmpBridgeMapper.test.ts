import { describe, expect, it } from 'vitest';
import { parseExtToBridgeLine } from './bridgeProtocol';
import { OmpBridgeMapper } from './OmpBridgeMapper';

describe('parseExtToBridgeLine', () => {
  it('accepts a hello line', () => {
    expect(parseExtToBridgeLine('{"t":"hello","v":1,"pid":42,"session":{"cwd":"/repo","ompSessionId":"s1","title":"Fix"}}\n')).toEqual({
      t: 'hello',
      v: 1,
      pid: 42,
      session: { cwd: '/repo', ompSessionId: 's1', title: 'Fix' },
    });
  });

  it('rejects non-JSON, unknown types, and missing fields', () => {
    expect(parseExtToBridgeLine('Happy CLI v1.2.5')).toBeNull();
    expect(parseExtToBridgeLine('{"t":"nope"}')).toBeNull();
    expect(parseExtToBridgeLine('{"t":"tool_start","id":"c1","name":"bash"}')).toBeNull();
    expect(parseExtToBridgeLine('   ')).toBeNull();
  });
});

describe('OmpBridgeMapper', () => {
  it('frames a turn and flushes assistant text before the tool call it precedes', () => {
    const mapper = new OmpBridgeMapper();

    const start = mapper.map({ t: 'status', status: 'busy' });
    expect(start.thinking).toBe(true);
    expect(start.envelopes.map((e) => e.ev.t)).toEqual(['turn-start']);
    const turn = start.envelopes[0].turn;

    expect(mapper.map({ t: 'assistant', text: 'Checking.' }).envelopes).toEqual([]);
    const call = mapper.map({ t: 'tool_start', id: 'c1', name: 'bash', args: { command: 'ls' } }).envelopes;
    expect(call.map((e) => e.ev)).toEqual([
      { t: 'text', text: 'Checking.' },
      expect.objectContaining({ t: 'tool-call-start', name: 'bash', args: { command: 'ls' } }),
    ]);
    const end = mapper.map({ t: 'tool_end', id: 'c1', name: 'bash', isError: false }).envelopes;
    expect(end[0].ev).toEqual({ t: 'tool-call-end', call: (call[1].ev as { call: string }).call });

    mapper.map({ t: 'assistant', text: 'Done.', thinking: 'looked fine' });
    const idle = mapper.map({ t: 'status', status: 'idle', outcome: 'completed' });
    expect(idle).toMatchObject({ thinking: false, turnEnded: true });
    expect(idle.envelopes.map((e) => e.ev)).toEqual([
      { t: 'text', text: 'Done.' },
      { t: 'turn-end', status: 'completed' },
    ]);
    expect([...call, ...end, ...idle.envelopes].every((e) => e.turn === turn)).toBe(true);
  });

  it('links an ask to the call id its tool card carries, whichever arrives first', () => {
    const mapper = new OmpBridgeMapper();
    mapper.map({ t: 'status', status: 'busy' });

    // omp reports the ask (tool_call) before the tool starts executing.
    const formToolUseId = mapper.sessionCallId('call_1|fc_1');
    const call = mapper.map({ t: 'tool_start', id: 'call_1|fc_1', name: 'ask', args: {} }).envelopes;
    const card = call.find((e) => e.ev.t === 'tool-call-start')!.ev as { call: string };

    expect(formToolUseId).not.toBe('call_1|fc_1');
    expect(card.call).toBe(formToolUseId);
    expect(mapper.sessionCallId('call_2|fc_2')).not.toBe(formToolUseId);
  });

  it('reports a failed turn with the error text', () => {
    const mapper = new OmpBridgeMapper();
    mapper.map({ t: 'status', status: 'busy' });

    const idle = mapper.map({ t: 'status', status: 'idle', error: 'rate limited' });

    expect(idle.envelopes.map((e) => e.ev)).toEqual([
      { t: 'service', text: 'Error: rate limited' },
      { t: 'turn-end', status: 'failed' },
    ]);
  });

  it('maps TUI-typed user text to a user envelope and drops empty text', () => {
    const mapper = new OmpBridgeMapper();

    const [envelope] = mapper.map({ t: 'user', text: 'hi from the laptop' }).envelopes;

    expect(envelope).toMatchObject({ role: 'user', ev: { t: 'text', text: 'hi from the laptop' } });
    expect(mapper.map({ t: 'user', text: '' }).envelopes).toEqual([]);
  });
});
