import test from 'node:test';
import assert from 'node:assert/strict';
import { directionalTarget } from '../web/tv/navigation.js';

test('remote follows rows and can return from a card to the sidebar', () => {
  const rects = [
    {left: 0, top: 0, width: 150, height: 200},
    {left: 200, top: 0, width: 200, height: 100},
    {left: 420, top: 0, width: 200, height: 100},
    {left: 200, top: 120, width: 200, height: 100},
  ];
  assert.equal(directionalTarget(rects, 1, 'right'), 2);
  assert.equal(directionalTarget(rects, 1, 'down'), 3);
  assert.equal(directionalTarget(rects, 1, 'left'), 0);
  assert.equal(directionalTarget(rects, 2, 'right'), 2);
});

test('empty or stale focus falls back to the first available control', () => {
  assert.equal(directionalTarget([], 0, 'down'), -1);
  assert.equal(directionalTarget([{left: 0, top: 0, width: 10, height: 10}], -1, 'down'), 0);
});
