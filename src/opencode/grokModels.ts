// @ts-nocheck — catalog fields extend SDK Model shape for grok-build provider config.
import type { Model as ModelV2 } from '@opencode-ai/sdk/v2';
import { getBaseUrl } from '../auth/oauth.js';
import { type GrokBuildModelConfig, resolveModels } from '../models/catalog.js';

export const GROK_BUILD_PROVIDER_ID = 'grok-build';

export function grokBuildProviderConfig() {
  const models = resolveModels();
  return {
    name: 'Grok Build',
    npm: '@ai-sdk/openai-compatible',
    api: getBaseUrl(),
    models: Object.fromEntries(
      models.map((m) => [
        m.id,
        {
          name: m.name,
          reasoning: m.reasoning,
          modalities: { input: m.input },
          cost: {
            input: m.cost.input,
            output: m.cost.output,
            cache: { read: m.cost.cacheRead, write: m.cost.cacheWrite },
          },
          limit: {
            context: m.contextWindow,
            output: m.maxTokens,
          },
        },
      ]),
    ),
  };
}

export function toPluginModels(
  providerModels: Record<string, ModelV2>,
  catalog: GrokBuildModelConfig[],
): Record<string, ModelV2> {
  const byId = new Map(catalog.map((m) => [m.id, m]));
  const result: Record<string, ModelV2> = {};

  for (const [modelID, model] of Object.entries(providerModels)) {
    const entry = byId.get(modelID);
    if (!entry) {
      result[modelID] = model;
      continue;
    }
    result[modelID] = {
      ...model,
      name: entry.name,
      reasoning: entry.reasoning,
      modalities: { input: entry.input },
      cost: {
        input: entry.cost.input,
        output: entry.cost.output,
        cache: { read: entry.cost.cacheRead, write: entry.cost.cacheWrite },
      },
      limit: {
        context: entry.contextWindow,
        output: entry.maxTokens,
      },
    };
  }

  for (const entry of catalog) {
    if (!result[entry.id]) {
      result[entry.id] = providerModels[entry.id] ?? ({} as ModelV2);
    }
  }

  return result;
}
