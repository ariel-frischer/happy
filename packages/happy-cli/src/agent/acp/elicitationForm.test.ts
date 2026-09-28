import { describe, expect, it } from 'vitest';

import {
  answersToElicitationResponse,
  elicitationToForm,
  type CreateElicitationRequest,
} from './elicitationForm';

const OTHER = { type: 'string', title: 'Other (type your own)' };

/** The request omp sends for `ask` with a single-select and a multi-select question. */
const ompAsk: CreateElicitationRequest = {
  mode: 'form',
  sessionId: 's1',
  message: 'Answer 2 questions',
  requestedSchema: {
    type: 'object',
    properties: {
      q0: {
        type: 'string',
        title: 'Which database?',
        description: 'Storage',
        oneOf: [
          { const: 'Postgres', title: 'Postgres', description: 'Relational' },
          { const: 'SQLite', title: 'SQLite' },
        ],
        default: 'SQLite',
      },
      q0__other: OTHER,
      q1: {
        type: 'array',
        title: 'Which targets?',
        items: { anyOf: [{ const: 'ios', title: 'iOS' }, { const: 'android', title: 'Android' }] },
      },
      q1__other: OTHER,
    },
  },
};

function form(request: CreateElicitationRequest) {
  const mapped = elicitationToForm(request);
  if (!mapped) throw new Error('expected a renderable form');
  return mapped;
}

describe('elicitationToForm', () => {
  it('maps omp single- and multi-select questions with an Other field', () => {
    const { questions } = form(ompAsk);
    expect(questions).toEqual([
      {
        id: 'q0',
        header: 'Storage',
        question: 'Which database?',
        options: [
          { label: 'Postgres', description: 'Relational' },
          { label: 'SQLite', description: 'Recommended' },
        ],
        multiSelect: false,
        allowCustom: true,
      },
      {
        id: 'q1',
        header: 'Question 2',
        question: 'Which targets?',
        options: [{ label: 'iOS' }, { label: 'Android' }],
        multiSelect: true,
        allowCustom: true,
      },
    ]);
  });

  it('uses the message as the question text for a single question', () => {
    const { questions, title } = form({
      mode: 'form',
      message: 'Deploy now?',
      requestedSchema: {
        properties: {
          q0: { type: 'string', title: 'Deploy now?', oneOf: [{ const: 'Yes', title: 'Yes' }] },
          q0__other: OTHER,
        },
      },
    });
    expect(title).toBe('Deploy now?');
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({ id: 'q0', question: 'Deploy now?', allowCustom: true });
  });

  it('keeps a question that only offers the Other field as a text question', () => {
    const { questions } = form({
      mode: 'form',
      message: 'Answer 2 questions',
      requestedSchema: {
        properties: {
          q0: { type: 'string', title: 'Pick one', oneOf: [{ const: 'A', title: 'A' }] },
          q0__other: OTHER,
          q1__other: OTHER,
        },
      },
    });
    expect(questions.map((q) => q.id)).toEqual(['q0', 'q1']);
    expect(questions[1]).toMatchObject({ options: [], allowCustom: true });
  });

  it('turns a choice question without an Other field into a closed choice', () => {
    const { questions } = form({
      mode: 'form',
      message: 'Pick',
      requestedSchema: {
        properties: { value: { type: 'string', enum: ['red', 'blue'] } },
        required: ['value'],
      },
    });
    expect(questions[0]).toMatchObject({
      options: [{ label: 'red' }, { label: 'blue' }],
      allowCustom: false,
      required: true,
    });
  });

  it('returns null for URL-mode or empty schemas so the caller declines', () => {
    expect(elicitationToForm({ mode: 'url', message: 'Sign in' })).toBeNull();
    expect(elicitationToForm({ mode: 'form', message: 'x', requestedSchema: { properties: {} } })).toBeNull();
  });
});

describe('answersToElicitationResponse', () => {
  it('sends selected option values and multi-select arrays', () => {
    expect(answersToElicitationResponse(form(ompAsk), {
      q0: { options: ['Postgres'] },
      q1: { options: ['iOS', 'Android'] },
    })).toEqual({
      action: 'accept',
      content: { q0: 'Postgres', q1: ['ios', 'android'] },
    });
  });

  it('writes custom text to the Other field alongside or instead of a choice', () => {
    expect(answersToElicitationResponse(form(ompAsk), {
      q0: { options: [], custom: '  MySQL  ' },
      q1: { options: ['Android'], custom: 'web' },
    })).toEqual({
      action: 'accept',
      content: { q0__other: 'MySQL', q1: ['android'], q1__other: 'web' },
    });
  });

  it('drops unknown labels and unanswered questions', () => {
    expect(answersToElicitationResponse(form(ompAsk), {
      q0: { options: ['Oracle'] },
    })).toEqual({ action: 'accept', content: {} });
  });

  it('maps boolean confirms and numeric text answers to typed values', () => {
    const confirm = form({
      mode: 'form',
      message: 'Continue?',
      requestedSchema: { properties: { value: { type: 'boolean' } } },
    });
    expect(answersToElicitationResponse(confirm, { value: { options: ['No'] } }))
      .toEqual({ action: 'accept', content: { value: false } });

    const count = form({
      mode: 'form',
      message: 'How many?',
      requestedSchema: { properties: { value: { type: 'integer' } } },
    });
    expect(answersToElicitationResponse(count, { value: { options: [], custom: '3' } }))
      .toEqual({ action: 'accept', content: { value: 3 } });
    expect(answersToElicitationResponse(count, { value: { options: [], custom: '2.5' } }))
      .toEqual({ action: 'accept', content: {} });
  });
});
