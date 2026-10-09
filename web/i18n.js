import {messages} from '../shared/messages.js';

export function createI18n(options = {}) {
  let storage, language = 'en';
  const document = options.document || globalThis.document;
  const bindings = new WeakMap();
  try {
    storage = Object.prototype.hasOwnProperty.call(options, 'storage') ? options.storage : globalThis.localStorage;
    const saved = storage?.getItem('boosty-tv-language');
    if (saved === 'ru' || saved === 'en') language = saved;
  } catch {}
  const text = (key, params = {}) => {
    const template = messages[language][key] || messages[language].request_failed;
    return template.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? ''));
  };
  function apply(node, binding) {
    const params = typeof binding.params === 'function' ? binding.params() : binding.params;
    const value = text(binding.key, params);
    if (binding.attribute) node.setAttribute(binding.attribute, value); else node.textContent = value;
  }
  function refresh() {
    if (!document) return;
    document.documentElement.lang = language;
    for (const node of document.querySelectorAll('*')) for (const binding of bindings.get(node)?.values() || []) apply(node, binding);
  }
  return {
    get language() {return language;},
    get locale() {return language === 'ru' ? 'ru-RU' : 'en-US';},
    text,
    bind(node, key, params = {}, attribute = '') {
      let entries = bindings.get(node);
      if (!entries) {entries = new Map(); bindings.set(node, entries);}
      if (!key) {entries.delete(attribute); return;}
      const binding = {key, params, attribute}; entries.set(attribute, binding); apply(node, binding);
    },
    refresh,
    setLanguage(value) {
      if (value !== 'en' && value !== 'ru') return;
      language = value;
      try {storage?.setItem('boosty-tv-language', value);} catch {}
      refresh();
    },
  };
}
