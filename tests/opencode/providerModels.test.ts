import type { Model } from '@opencode/plugin';
import { describe, expect, it, vi } from 'vitest';
import { resolveModels } from '../../src/models/catalog.js';
import { grokBuildModels, grokBuildProvider } from '../../src/opencode/providerModels.js';

const variantIds = (models: Model.Info[], id: string) =>
  models.find((model) => model.id === id)?.variants.map((variant) => variant.id);

describe('Grok Build provider registration data', () => {
  it('describes the proxy-backed xAI provider', () => {
    expect(grokBuildProvider()).toMatchObject({
      id: 'grok-build',
      name: 'Grok Build',
      activation: 'auto',
      integrationID: 'grok-build',
      package: '@opencode/ai/providers/xai',
      settings: { baseURL: 'https://cli-chat-proxy.grok.com/v1', transport: 'http' },
    });
  });

  it('honours the base URL override without a trailing slash', () => {
    vi.stubEnv('GROK_BUILD_BASE_URL', 'https://proxy.test/v1/');

    expect(grokBuildProvider().settings?.baseURL).toBe('https://proxy.test/v1');

    vi.unstubAllEnvs();
  });

  it('exposes the full catalog with pricing and limits', () => {
    const models = grokBuildModels();

    expect(models.map((model) => model.id)).toEqual(resolveModels().map((model) => model.id));
    expect(models).toHaveLength(10);
    expect(models.find((model) => model.id === 'grok-4.7')).toMatchObject({
      providerID: 'grok-build',
      modelID: 'grok-4.7',
      name: 'Grok 4.7',
      capabilities: { tools: true, input: ['text', 'image'], output: ['text'] },
      cost: [{ input: 2, output: 6, cache: { read: 0.5, write: 0 } }],
      limit: { context: 500_000, output: 30_000 },
    });
    expect(models.find((model) => model.id === 'grok-4.7-build-fast')?.cost).toEqual([
      { input: 4, output: 12, cache: { read: 1, write: 0 } },
    ]);
  });

  it('adds reasoning-effort variants only where the model supports them', () => {
    const models = grokBuildModels();

    for (const id of ['grok-4.6', 'grok-4.7', 'grok-4.7-build-fast']) {
      expect(variantIds(models, id)).toEqual(['low', 'medium', 'high', 'xhigh']);
    }
    expect(variantIds(models, 'grok-4.5')).toEqual(['low', 'medium', 'high']);
    expect(variantIds(models, 'grok-build')).toEqual([]);
    expect(variantIds(models, 'grok-composer-2.5-fast')).toEqual([]);
    expect(models.find((model) => model.id === 'grok-4.7')?.variants).toEqual([
      { id: 'low', settings: { reasoningEffort: 'low' } },
      { id: 'medium', settings: { reasoningEffort: 'medium' } },
      { id: 'high', settings: { reasoningEffort: 'high' } },
      { id: 'xhigh', settings: { reasoningEffort: 'xhigh' } },
    ]);
  });

  it('follows the GROK_BUILD_MODELS filter including unknown identifiers', () => {
    vi.stubEnv('GROK_BUILD_MODELS', ' custom , grok-4.7 ');

    const models = grokBuildModels();

    expect(models.map((model) => model.id)).toEqual(['custom', 'grok-4.7']);
    expect(models[0]).toMatchObject({
      capabilities: { input: ['text'] },
      limit: { context: 1_000_000 },
      variants: [],
    });

    vi.unstubAllEnvs();
  });
});
