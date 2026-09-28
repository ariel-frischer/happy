import { describe, expect, it } from 'vitest';

import type { OmpAskQuestion } from './bridgeProtocol';
import { formAnswersToOmpAsk, ompAskToForm, ompAskToFormAnswers } from './ompAskForm';

const single: OmpAskQuestion = {
  id: 'db',
  question: 'Which database?',
  header: 'Storage',
  options: [{ label: 'Postgres', description: 'relational' }, { label: 'SQLite' }],
  recommended: 1,
};
const multi: OmpAskQuestion = {
  id: 'features',
  question: 'Which features?',
  options: [{ label: 'Auth' }, { label: 'Billing' }, { label: 'Search' }],
  multi: true,
  recommended: 0,
};
const free: OmpAskQuestion = { id: 'name', question: 'Project name?', options: [{ label: 'demo' }] };

describe('ompAskToForm', () => {
  it('renders every question with custom text allowed and marks the recommended single choice', () => {
    const form = ompAskToForm([single, multi, free]);

    expect(form.title).toBe('3 questions');
    expect(form.questions).toEqual([
      {
        id: 'db',
        header: 'Storage',
        question: 'Which database?',
        options: [{ label: 'Postgres', description: 'relational' }, { label: 'SQLite', description: 'Recommended' }],
        multiSelect: false,
        allowCustom: true,
        required: true,
      },
      {
        id: 'features',
        header: 'Question 2',
        question: 'Which features?',
        // A recommendation means nothing for a multi-select.
        options: [{ label: 'Auth' }, { label: 'Billing' }, { label: 'Search' }],
        multiSelect: true,
        allowCustom: true,
        required: false,
      },
      {
        id: 'name',
        header: 'Question 3',
        question: 'Project name?',
        options: [{ label: 'demo' }],
        multiSelect: false,
        allowCustom: true,
        required: true,
      },
    ]);
  });

  it('titles a single-question form with the question', () => {
    expect(ompAskToForm([single]).title).toBe('Which database?');
  });
});

describe('formAnswersToOmpAsk', () => {
  it('returns results in question order with single, multi, and typed answers', () => {
    const results = formAnswersToOmpAsk([single, multi, free], {
      name: { options: [], custom: '  zeta  ' },
      features: { options: ['Search', 'Auth'] },
      db: { options: ['Postgres'] },
    });

    expect(results).toEqual([
      { id: 'db', question: 'Which database?', options: ['Postgres', 'SQLite'], multi: false, selectedOptions: ['Postgres'] },
      { id: 'features', question: 'Which features?', options: ['Auth', 'Billing', 'Search'], multi: true, selectedOptions: ['Search', 'Auth'] },
      { id: 'name', question: 'Project name?', options: ['demo'], multi: false, selectedOptions: [], customInput: 'zeta' },
    ]);
  });

  it('lets typed text replace a single choice but keep multi-select choices', () => {
    const [db, features] = formAnswersToOmpAsk([single, multi], {
      db: { options: ['SQLite'], custom: 'MySQL' },
      features: { options: ['Billing'], custom: 'Exports' },
    });

    expect(db).toMatchObject({ selectedOptions: [], customInput: 'MySQL' });
    expect(features).toMatchObject({ selectedOptions: ['Billing'], customInput: 'Exports' });
  });

  it('drops labels omp did not offer and leaves unanswered questions empty', () => {
    const [db, features] = formAnswersToOmpAsk([single, multi], {
      db: { options: ['Oracle', 'SQLite', 'Postgres'], custom: '   ' },
    });

    expect(db).toEqual({ id: 'db', question: 'Which database?', options: ['Postgres', 'SQLite'], multi: false, selectedOptions: ['SQLite'] });
    expect(features.selectedOptions).toEqual([]);
    expect(features).not.toHaveProperty('customInput');
  });
});

describe('ompAskToFormAnswers', () => {
  it('reports answers given in the TUI in the app shape', () => {
    expect(ompAskToFormAnswers([
      { id: 'db', selectedOptions: ['SQLite'] },
      { id: 'name', selectedOptions: [], customInput: 'zeta' },
    ])).toEqual({
      db: { options: ['SQLite'] },
      name: { options: [], custom: 'zeta' },
    });
  });
});
