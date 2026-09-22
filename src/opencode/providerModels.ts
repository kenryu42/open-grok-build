import { Integration, Model, Provider } from '@opencode/plugin';
import { getBaseUrl } from '../auth/oauth.js';
import {
  type GrokBuildModelConfig,
  resolveModels,
  supportsReasoningEffort,
} from '../models/catalog.js';

export const GROK_BUILD_PROVIDER_ID = 'grok-build';

// Model costs are branded USD per million tokens; brand the catalog's plain numbers.
const usd = (value: number) => Model.Cost.fields.input.make(value);

const cost = (model: GrokBuildModelConfig) => ({
  input: usd(model.cost.input),
  output: usd(model.cost.output),
  cache: { read: usd(model.cost.cacheRead), write: usd(model.cost.cacheWrite) },
});

export function grokBuildProvider(): Provider.Info {
  return {
    id: Provider.ID.make(GROK_BUILD_PROVIDER_ID),
    name: 'Grok Build',
    activation: 'auto',
    integrationID: Integration.ID.make(GROK_BUILD_PROVIDER_ID),
    package: '@opencode/ai/providers/xai',
    settings: { baseURL: getBaseUrl(), transport: 'http' },
  };
}

function variants(model: GrokBuildModelConfig) {
  if (!supportsReasoningEffort(model.id)) return [];
  const levels = ['low', 'medium', 'high'];
  const all = model.thinkingLevelMap?.xhigh === 'xhigh' ? [...levels, 'xhigh'] : levels;
  return all.map((level) => ({
    id: Model.VariantID.make(level),
    settings: { reasoningEffort: level },
  }));
}

export function grokBuildModels(models: GrokBuildModelConfig[] = resolveModels()): Model.Info[] {
  const providerID = grokBuildProvider().id;
  return models.map((model) => ({
    ...Model.Info.default(providerID, Model.ID.make(model.id)),
    name: model.name,
    capabilities: { tools: true, input: [...model.input], output: ['text'] },
    cost: [cost(model)],
    limit: { context: model.contextWindow, output: model.maxTokens },
    variants: variants(model),
  }));
}
