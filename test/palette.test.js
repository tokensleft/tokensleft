import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COLOR, resolveUiColor } from '../lib/palette.js';

test('semantic palette uses valid 256-color indexes with distinct status tones', () => {
  for (const value of Object.values(COLOR)) {
    assert.ok(Number.isInteger(value) && value >= 0 && value <= 255);
  }

  assert.equal(new Set([COLOR.success, COLOR.warning, COLOR.danger]).size, 3);
  assert.ok(COLOR.text > COLOR.frame);
});

test('legacy tone names resolve to the softer semantic palette', () => {
  assert.equal(resolveUiColor('green'), COLOR.success);
  assert.equal(resolveUiColor('yellow'), COLOR.warning);
  assert.equal(resolveUiColor('red'), COLOR.danger);
  assert.equal(resolveUiColor(123), 123);
});
