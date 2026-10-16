import closeSource from '../../src-tauri/capabilities/settings-close.json?raw';
import defaultSource from '../../src-tauri/capabilities/default.json?raw';
import detailSource from '../../src-tauri/capabilities/detail.json?raw';
import { describe, expect, it } from 'vitest';

describe('settings close capability', () => {
  it('allows the SDK close handler to destroy without granting other windows that capability', () => {
    const capability = JSON.parse(closeSource);
    expect(capability.windows).toEqual(['settings']);
    expect(capability.permissions).toEqual(['core:window:allow-destroy']);
    for (const source of [defaultSource, detailSource]) {
      const other = JSON.parse(source);
      expect(other.permissions).not.toContain('core:window:allow-destroy');
    }
  });
});
