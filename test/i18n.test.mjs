import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {createI18n} from '../web/i18n.js';
import {messages} from '../shared/messages.js';

test('English is the default and storage failures never prevent language changes', () => {
  for (const storage of [undefined, {getItem() {throw Error('blocked');}, setItem() {throw Error('blocked');}}, {getItem: () => 'invalid'}]) {
    const i18n = createI18n({storage}); assert.equal(i18n.language, 'en');
    i18n.setLanguage('ru'); assert.equal(i18n.text('feed'), 'Лента');
  }
  assert.equal(createI18n({storage: {getItem: () => 'ru'}}).language, 'ru');
});

test('catalog keys and parameters match and refreshed bindings never interpret HTML', () => {
  assert.deepEqual(Object.keys(messages.en).sort(), Object.keys(messages.ru).sort());
  for (const key of Object.keys(messages.en)) assert.deepEqual((messages.en[key].match(/\{\w+\}/g) || []).sort(), (messages.ru[key].match(/\{\w+\}/g) || []).sort(), key);
  const {document} = parseHTML('<html><body><p></p></body></html>');
  const i18n = createI18n({storage: null, document}); const node = document.querySelector('p');
  i18n.bind(node, 'qualityValue', {value: '<img onerror=alert(1)>'});
  assert.equal(node.children.length, 0); i18n.setLanguage('ru');
  assert.equal(node.textContent, 'Качество: <img onerror=alert(1)>');
  node.remove(); i18n.setLanguage('en'); document.body.append(node); i18n.refresh();
  assert.equal(node.textContent, 'Quality: <img onerror=alert(1)>');
});
