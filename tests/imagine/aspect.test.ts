import { describe, expect, it } from 'vitest';
import { IMAGINE_ASPECT_RATIOS, normalizeAspectRatio } from '../../src/imagine/aspect.js';

describe('normalizeAspectRatio', () => {
  it.each(IMAGINE_ASPECT_RATIOS)('accepts %s', (value) =>
    expect(normalizeAspectRatio(value)).toBe(value));

  it('defaults to auto and rejects unsupported ratios', () => {
    expect(normalizeAspectRatio()).toBe('auto');
    expect(normalizeAspectRatio(' 16:9 ')).toBe('16:9');
    expect(() => normalizeAspectRatio('5:4')).toThrow('Unsupported aspect ratio');
  });
});
