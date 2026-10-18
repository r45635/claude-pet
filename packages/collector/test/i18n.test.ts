import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// @ts-ignore — a plain browser module, typed by its JSDoc only.
import { LANGUAGES, fmt, resolveLocale, setLocale, t } from '../../../apps/widget/web/i18n.js';

const WIDGET = join(import.meta.dirname, '..', '..', '..', 'apps', 'widget');
const page = readFileSync(join(WIDGET, 'web', 'index.html'), 'utf8');
// The menu's own tests use a made-up key on purpose: only the code before them counts.
const menu = readFileSync(join(WIDGET, 'src-tauri', 'src', 'menu.rs'), 'utf8').split('#[cfg(test)]')[0];
const keysOf = (lang: Record<string, unknown>) => Object.keys(lang).filter((k) => k !== '_comment').sort();

test('i18n: every language has exactly the reference (English) keys', () => {
  const en = keysOf(LANGUAGES.en);
  for (const [code, lang] of Object.entries(LANGUAGES)) {
    assert.deepEqual(keysOf(lang as Record<string, unknown>), en, `${code}.json`);
  }
});

test('i18n: every key the page and the native menu use exists', () => {
  const used = new Set<string>();
  for (const m of page.matchAll(/\bt\('([\w.]+)'/g)) used.add(m[1]);
  for (const m of page.matchAll(/data-i18n(?:-\w+)?="([\w.]+)"/g)) used.add(m[1]);
  for (const m of menu.matchAll(/"(menu\.[\w.]+)"/g)) used.add(m[1]);
  // Keys built from closed enums: every value must have its string.
  for (const tool of ['bash', 'read', 'write', 'edit', 'search', 'fetch', 'task', 'todo', 'notebook', 'mcp', 'other']) used.add(`why.tool.${tool}`);
  for (const code of ['rate_limit', 'overloaded', 'server_error', 'other']) used.add(`why.api.${code}`);
  for (const code of ['already_answering', 'claude_not_found', 'cannot_start', 'chat_disabled', 'empty_message', 'stopped', 'other']) {
    used.add(`chat.error.${code}`);
  }
  assert.ok(used.size > 40, `found only ${used.size} keys: the scan is broken`);
  const missing = [...used].filter((k) => !(k in LANGUAGES.en));
  assert.deepEqual(missing, []);
});

test('i18n: plurals and variables', () => {
  setLocale('en');
  assert.equal(t('why.subagents', { n: 1 }), '1 subagent running');
  assert.equal(t('why.subagents', { n: 3 }), '3 subagents running');
  setLocale('fr');
  assert.equal(t('why.subagents', { n: 1 }), '1 sous-agent actif');
  assert.equal(t('why.subagents', { n: 2 }), '2 sous-agents actifs');
  assert.equal(t('why.toolFailed', { tool: t('why.tool.bash') }), 'Bash a échoué');
  assert.equal(t('no.such.key'), 'no.such.key', 'a missing key shows itself, never crashes');
  setLocale('en');
});

test('i18n: auto follows the system, unknown languages fall back to English', () => {
  assert.equal(resolveLocale('auto', 'fr-CA'), 'fr');
  assert.equal(resolveLocale('auto', 'de-DE'), 'en');
  assert.equal(resolveLocale('fr', 'en-US'), 'fr');
  assert.equal(resolveLocale('xx', 'fr-FR'), 'en');
});

test('i18n: numbers, money and durations follow the language', () => {
  setLocale('en');
  assert.equal(fmt.seconds(2_800), '2.8 sec');
  assert.match(fmt.usd(0.1357), /^\$0\.136$/);
  setLocale('fr');
  assert.match(fmt.seconds(2_800), /^2,8\s?s$/);
  assert.match(fmt.usd(0.1357), /^0,136\s?\$/);
  assert.match(fmt.compact(12_400), /^12,4\s?k$/);
  setLocale('en');
});
