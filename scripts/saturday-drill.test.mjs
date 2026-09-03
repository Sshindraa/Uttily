import assert from 'node:assert/strict';
import test from 'node:test';
import { runSaturdayDrill } from './saturday-drill.mjs';

test('runSaturdayDrill expose une fonction appelable', () => {
  assert.equal(typeof runSaturdayDrill, 'function');
});
