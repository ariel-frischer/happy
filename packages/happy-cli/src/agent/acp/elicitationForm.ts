/**
 * Pure mapping between ACP form elicitations (`elicitation/create`) and the
 * AgentState `form` communication the Happy app already renders.
 *
 * `@agentclientprotocol/sdk` 0.14.1 has no elicitation types, so the wire shapes
 * are declared here from the ACP draft that omp implements.
 */

import type { AgentQuestion, AgentQuestionAnswer } from '@/api/types';

/** Method name an agent uses to ask the client for structured input. */
export const ELICITATION_CREATE_METHOD = 'elicitation/create';

/** Suffix omp uses for the free-text companion of a choice question (`q0__other`). */
const OTHER_SUFFIX = '__other';

export type ElicitationChoice = { const: unknown; title?: string; description?: string };

export type ElicitationPropertySchema = {
  type?: string;
  title?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  oneOf?: ElicitationChoice[];
  anyOf?: ElicitationChoice[];
  items?: { type?: string; enum?: unknown[]; oneOf?: ElicitationChoice[]; anyOf?: ElicitationChoice[] };
};

export type CreateElicitationRequest = {
  mode?: string;
  sessionId?: string;
  message?: string;
  requestedSchema?: {
    type?: string;
    properties?: Record<string, ElicitationPropertySchema>;
    required?: string[];
  };
};

export type ElicitationContentValue = string | number | boolean | string[];

export type CreateElicitationResponse =
  | { action: 'accept'; content: Record<string, ElicitationContentValue> }
  | { action: 'decline' }
  | { action: 'cancel' };

/** How one rendered question writes its answer back into the elicitation content. */
type FieldBinding = {
  questionId: string;
  /** Property receiving the selected option value(s); absent for free-text-only questions. */
  valueKey?: string;
  /** Property receiving free text, if the schema accepts one. */
  customKey?: string;
  /** Coerces free text written to `customKey` (number/integer properties). */
  customType: 'string' | 'number' | 'integer';
  multiSelect: boolean;
  /** Option label shown in the app -> value sent to the agent. */
  optionValues: Map<string, ElicitationContentValue>;
};

export type ElicitationForm = {
  title: string;
  questions: AgentQuestion[];
  bindings: FieldBinding[];
};

const RECOMMENDED = 'Recommended';

function choicesOf(schema: ElicitationPropertySchema): ElicitationChoice[] | null {
  const source = schema.type === 'array' ? schema.items : schema;
  if (!source) return null;
  const labelled = source.oneOf ?? source.anyOf;
  if (labelled && labelled.length > 0) return labelled;
  if (source.enum && source.enum.length > 0) return source.enum.map((value) => ({ const: value }));
  if (schema.type === 'boolean') return [{ const: true, title: 'Yes' }, { const: false, title: 'No' }];
  return null;
}

function isContentValue(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/**
 * Turns a form elicitation into app questions plus the bindings needed to map
 * the answers back. Returns null when nothing in the schema can be rendered,
 * so the caller can decline instead of showing an empty form.
 */
export function elicitationToForm(request: CreateElicitationRequest): ElicitationForm | null {
  if (request.mode !== undefined && request.mode !== 'form') return null;
  const properties = request.requestedSchema?.properties ?? {};
  const required = new Set(request.requestedSchema?.required ?? []);
  const keys = Object.keys(properties);
  const baseKeys: string[] = [];
  for (const key of keys) {
    const base = key.endsWith(OTHER_SUFFIX) ? key.slice(0, -OTHER_SUFFIX.length) : key;
    if (!baseKeys.includes(base)) baseKeys.push(base);
  }

  const message = request.message?.trim() ?? '';
  const questions: AgentQuestion[] = [];
  const bindings: FieldBinding[] = [];

  for (const [index, base] of baseKeys.entries()) {
    const schema = properties[base] as ElicitationPropertySchema | undefined;
    const otherKey = `${base}${OTHER_SUFFIX}`;
    const otherSchema = properties[otherKey];
    const choices = schema ? choicesOf(schema) : null;
    const multiSelect = schema?.type === 'array';

    const optionValues = new Map<string, ElicitationContentValue>();
    const options: AgentQuestion['options'] = [];
    for (const choice of choices ?? []) {
      if (!isContentValue(choice.const)) continue;
      const label = choice.title?.trim() || String(choice.const);
      if (optionValues.has(label)) continue;
      optionValues.set(label, choice.const);
      const recommended = !multiSelect && schema?.default !== undefined && schema.default === choice.const;
      const description = [choice.description?.trim(), recommended ? RECOMMENDED : undefined].filter(Boolean).join(' · ');
      options.push(description ? { label, description } : { label });
    }

    // A schema property without choices (plain string/number) is answered as free text.
    const textOnly = options.length === 0;
    const customKey = otherSchema ? otherKey : textOnly && schema ? base : undefined;
    if (textOnly && !customKey) continue;
    const customSchema = customKey === base ? schema : otherSchema;

    const title = schema?.title?.trim() || otherSchema?.title?.trim();
    const question = (baseKeys.length === 1 ? message : '') || title || message || base;
    const header = schema?.description?.trim()
      || (baseKeys.length === 1 ? '' : title && title !== question ? title : '')
      || `Question ${index + 1}`;

    questions.push({
      id: base,
      header,
      question,
      options,
      multiSelect,
      allowCustom: customKey !== undefined,
      ...(required.has(base) ? { required: true } : {}),
    });
    bindings.push({
      questionId: base,
      ...(textOnly ? {} : { valueKey: base }),
      ...(customKey ? { customKey } : {}),
      customType: customSchema?.type === 'number' || customSchema?.type === 'integer' ? customSchema.type : 'string',
      multiSelect,
      optionValues,
    });
  }

  if (questions.length === 0) return null;
  return { title: message || 'Answer the agent', questions, bindings };
}

/** Maps the app's answers back to the `content` of an accepted elicitation. */
export function answersToElicitationResponse(
  form: Pick<ElicitationForm, 'bindings'>,
  answers: Record<string, AgentQuestionAnswer> | undefined,
): CreateElicitationResponse {
  const content: Record<string, ElicitationContentValue> = {};
  for (const binding of form.bindings) {
    const answer = answers?.[binding.questionId];
    if (!answer) continue;

    if (binding.valueKey) {
      const values = answer.options
        .map((label) => binding.optionValues.get(label))
        .filter((value): value is ElicitationContentValue => value !== undefined);
      if (binding.multiSelect) {
        if (values.length > 0) content[binding.valueKey] = values.map(String);
      } else if (values.length > 0) {
        content[binding.valueKey] = values[0];
      }
    }

    const custom = answer.custom?.trim();
    if (custom && binding.customKey) {
      if (binding.customType === 'string') {
        content[binding.customKey] = custom;
      } else {
        const parsed = Number(custom);
        if (Number.isFinite(parsed) && (binding.customType === 'number' || Number.isInteger(parsed))) {
          content[binding.customKey] = parsed;
        }
      }
    }
  }
  return { action: 'accept', content };
}

export const CANCELLED_ELICITATION: CreateElicitationResponse = { action: 'cancel' };
