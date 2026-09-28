/**
 * Pure mapping between omp's `ask` dialog and the AgentState `form`
 * communication the Happy app renders (the same form ACP elicitations use).
 */
import type { AgentQuestion, AgentQuestionAnswer } from '@/api/types';
import type { OmpAskAnswer, OmpAskQuestion, OmpAskResultItem } from './bridgeProtocol';

const RECOMMENDED = 'Recommended';

/** Every omp ask question accepts a typed answer ("Other"), so every question allows custom text. */
export function ompAskToForm(questions: OmpAskQuestion[]): { title: string; questions: AgentQuestion[] } {
  const mapped = questions.map((q, index): AgentQuestion => {
    const multi = q.multi === true;
    return {
      id: q.id,
      header: q.header?.trim() || `Question ${index + 1}`,
      question: q.question,
      options: q.options.map((option, optionIndex) => {
        const recommended = !multi && q.recommended === optionIndex;
        const description = [option.description?.trim(), recommended ? RECOMMENDED : undefined].filter(Boolean).join(' · ');
        return description ? { label: option.label, description } : { label: option.label };
      }),
      multiSelect: multi,
      allowCustom: true,
      // Choosing nothing is a valid multi-select answer in omp; a single choice needs an answer.
      required: !multi,
    };
  });
  const title = questions.length === 1 ? questions[0].question : `${questions.length} questions`;
  return { title, questions: mapped };
}

/**
 * Maps the app's answers to the results omp's ask dialog returns, in question
 * order (the ask tool rejects results that do not line up with its questions).
 * Unknown option labels are dropped. A typed answer replaces the choice for a
 * single-choice question, as in omp's own "Other (type your own)".
 */
export function formAnswersToOmpAsk(
  questions: OmpAskQuestion[],
  answers: Record<string, AgentQuestionAnswer>,
): OmpAskResultItem[] {
  return questions.map((q) => {
    const multi = q.multi === true;
    const labels = q.options.map((option) => option.label);
    const answer = answers[q.id];
    const custom = answer?.custom?.trim() || undefined;
    const chosen = (answer?.options ?? []).filter((label) => labels.includes(label));
    const selectedOptions = multi ? chosen : custom ? [] : chosen.slice(0, 1);
    return {
      id: q.id,
      question: q.question,
      options: labels,
      multi,
      selectedOptions,
      ...(custom ? { customInput: custom } : {}),
    };
  });
}

/** Answers given in the TUI, in the app's shape, so the closed form shows what was chosen. */
export function ompAskToFormAnswers(answers: OmpAskAnswer[]): Record<string, AgentQuestionAnswer> {
  const result: Record<string, AgentQuestionAnswer> = {};
  for (const answer of answers) {
    result[answer.id] = {
      options: answer.selectedOptions,
      ...(answer.customInput !== undefined ? { custom: answer.customInput } : {}),
    };
  }
  return result;
}
