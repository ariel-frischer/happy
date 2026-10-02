import type { Metadata } from '@/api/types';
import type { OmpConfig } from './bridgeProtocol';

type ConfigMetadata = Pick<Metadata, 'models' | 'currentModelCode' | 'thoughtLevels' | 'currentThoughtLevelCode'>;

/**
 * omp's current model and thinking level as session metadata. The thinking
 * levels are the ones the current model accepts, so the app can switch between
 * them; an extension that reports no list leaves just the current level. The
 * model catalog holds only the current model (the app cannot switch it).
 * Fields omp does not report are cleared rather than left stale.
 */
export function ompConfigMetadata(config: OmpConfig): ConfigMetadata {
  const { model, thinkingLevel, thinkingLevels } = config;
  const levels = thinkingLevels?.length ? thinkingLevels : thinkingLevel ? [thinkingLevel] : [];
  return {
    models: model ? [{ code: model.code, value: model.name }] : undefined,
    currentModelCode: model?.code,
    thoughtLevels: levels.length > 0 ? levels.map((level) => ({ code: level, value: level })) : undefined,
    currentThoughtLevelCode: thinkingLevel || undefined,
  };
}
