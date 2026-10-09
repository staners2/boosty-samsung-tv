import {Api} from '../api.js';
import {createI18n} from '../i18n.js';
const i18n = createI18n();
const api = new Api(globalThis.BOOSTY_TV_API || '');
const $ = id => document.getElementById(id);
const id = location.pathname.split('/').pop(), key = location.hash.slice(1);
history.replaceState(null, '', location.pathname);
let busy = false;
const headers = {'X-Link-Key': key};
function status(key, error = false, params = {}) {
  i18n.bind($('status'), key, params); $('status').classList.toggle('error', error);
}
function buttons() {for (const id of ['send', 'verify', 'resend']) $(id).disabled = busy;}
async function submit(task) {
  if (busy) return;
  busy = true; buttons(); status('requesting');
  try {await task();} catch (error) {status(error.messageKey || 'request_failed', true);}
  finally {busy = false; buttons();}
}
async function send() {
  await api.post(`/api/pairs/${id}/send`, {phone: $('phone').value}, headers);
  $('code-form').hidden = false; status('codeSent'); $('code').focus();
}
$('phone-form').addEventListener('submit', event => {event.preventDefault(); submit(send);});
$('resend').addEventListener('click', () => submit(send));
$('code-form').addEventListener('submit', event => {
  event.preventDefault();
  submit(async () => {
    const result = await api.post(`/api/pairs/${id}/verify`, {code: $('code').value.trim()}, headers);
    $('phone-form').hidden = true; $('code-form').hidden = true;
    status('profileVerified', false, {name: result.profile.name});
  });
});
for (const [selector, key] of [
  ['title', 'linkTitle'], ['.eyebrow', 'linkEyebrow'], ['h1', 'linkHeading'], ['.notice', 'linkNotice'],
  ['label[for="phone"]', 'phoneLabel'], ['#send', 'sendCode'], ['label[for="code"]', 'codeLabel'],
  ['.hint', 'codeHint'], ['#verify', 'verify'], ['#resend', 'resend'], ['.privacy', 'privacy'],
]) i18n.bind(document.querySelector(selector), key);
$('language').onclick = () => {
  i18n.setLanguage(i18n.language === 'en' ? 'ru' : 'en');
  $('language').textContent = i18n.language === 'en' ? 'EN / RU' : 'RU / EN';
};
i18n.refresh();
status('checkingLink');
async function boot() {
  if (!/^[\w-]{24}$/.test(id) || !/^[\w-]{43}$/.test(key)) {
    $('phone-form').hidden = true; status('scanAgain', true); return;
  }
  try {
    const pair = await api.get(`/api/pairs/${id}`, headers);
    i18n.bind($('device'), 'device', {name: pair.name});
    if (pair.state === 'confirm') {$('phone-form').hidden = true; status('alreadyConfirmed', false, {name: pair.profile.name});}
    else status('signIn');
  } catch (error) {$('phone-form').hidden = true; status(error.messageKey || 'request_failed', true);}
}
boot();
