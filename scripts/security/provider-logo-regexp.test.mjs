import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('ProviderLogo uses parser-compatible equivalent HTML-comment regexp', () => {
  const source = readFileSync(new URL('../../src/components/ProviderLogo.tsx', import.meta.url), 'utf8');
  assert.ok(source.includes(String.raw`.replace(/\x3c!--[\s\S]*?-->/g, '')`));
});

test('escaped opener preserves HTML-comment removal semantics', () => {
  // These are test-owned literals; never import/evaluate the target component.
  const original = new RegExp(String.raw`<!--[\s\S]*?-->`, 'g');
  const compatible = /\x3c!--[\s\S]*?-->/g;
  const samples = ['', '<svg/>', '<!--comment--><svg/>', '<svg><!--a\nb--></svg>',
    '<!--a--><!--b-->', '<!--unterminated', '<!---->', '<!--a--->',
    '<!--nested<!--inner-->tail-->', 'x<!--\u2028\u2029-->y', '<!--<script>x</script>-->'];
  for (const input of samples) assert.equal(input.replace(compatible, ''), input.replace(original, ''));
});
