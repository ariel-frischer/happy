import type { Metadata } from '@/api/types';
import type { OmpConfig } from './bridgeProtocol';

type ConfigMetadata = Pick<Metadata, 'models' | 'currentModelCode' | 'thoughtLevels' | 'currentThoughtLevelCode'>;

/**
 * omp's current model and thinking level as session metadata: one-row catalogs
 * holding just the current values (the app shows them; it cannot switch them).
 * Fields omp does not report are cleared rather than left stale.
 */
export function ompConfigMetadata(config: OmpConfig): ConfigMetadata {
  const { model, thinkingLevel } = config;
  return {
    models: model ? [{ code: model.code, value: model.name }] : undefined,
    currentModelCode: model?.code,
    thoughtLevels: thinkingLevel ? [{ code: thinkingLevel, value: thinkingLevel }] : undefined,
    currentThoughtLevelCode: thinkingLevel || undefined,
  };
}
