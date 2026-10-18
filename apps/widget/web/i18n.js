/**
 * The pet's languages. Strings live in i18n/<code>.json (flat keys, {variables}, plurals
 * as {one, other}); English is the reference and the fallback for any missing key.
 * Numbers, durations, money and times go through Intl, so they read naturally in each
 * language. No dependency, both files bundled (a few KB): switching is instant.
 *
 * To add a language: copy i18n/en.json to i18n/<code>.json, translate, add it to
 * LANGUAGES below and to the "locale" values in settings-schema.json.
 */

import en from './i18n/en.json' with { type: 'json' };
import fr from './i18n/fr.json' with { type: 'json' };

export const LANGUAGES = { en, fr };
let locale = 'en';

/** `auto` follows the system (navigator.language); anything unknown falls back to English. */
export function resolveLocale(pref, system = globalThis.navigator?.language ?? 'en') {
  const want = pref && pref !== 'auto' ? pref : String(system).slice(0, 2).toLowerCase();
  return Object.hasOwn(LANGUAGES, want) ? want : 'en';
}

export function setLocale(pref) {
  locale = resolveLocale(pref);
  if (globalThis.document) document.documentElement.lang = locale;
  return locale;
}

export const currentLocale = () => locale;

/** The string for `key`, with {vars} filled in; a plural picks its form from vars.n. */
export function t(key, vars = {}) {
  let s = LANGUAGES[locale][key] ?? en[key] ?? key;
  if (s && typeof s === 'object') {
    s = s[new Intl.PluralRules(locale).select(Number(vars.n ?? 0))] ?? s.other;
  }
  return String(s).replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m));
}

const nf = (opts) => new Intl.NumberFormat(locale, opts);
export const fmt = {
  number: (n, digits = 0) => nf({ maximumFractionDigits: digits }).format(n),
  /** 2,8 s / 2.8 s */
  seconds: (ms) => nf({ style: 'unit', unit: 'second', maximumFractionDigits: 1 }).format(ms / 1000),
  /** 0,136 $US / $0.136 */
  usd: (v) => nf({ style: 'currency', currency: 'USD', maximumFractionDigits: 3 }).format(v),
  /** 12 k / 12K */
  compact: (n) => nf({ notation: 'compact', maximumFractionDigits: 1 }).format(n),
  percent: (pct) => nf({ style: 'percent', maximumFractionDigits: 0 }).format(pct / 100),
  /** 14:05 / 2:05 PM */
  time: (date) => new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(date),
  /** 2 h 5 min / 2h 5m — Intl.DurationFormat where available. */
  duration: (minutes) => {
    const h = Math.floor(minutes / 60);
    const m = Math.round(minutes % 60);
    if (typeof Intl.DurationFormat === 'function') {
      return new Intl.DurationFormat(locale, { style: 'narrow' }).format(h ? { hours: h, minutes: m } : { minutes: m });
    }
    return h ? `${h}h${String(m).padStart(2, '0')}` : `${m}m`;
  },
};

/** Fill elements marked data-i18n (text), data-i18n-title, -placeholder, -aria, -empty. */
export function translateDom(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
  for (const el of root.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
  for (const el of root.querySelectorAll('[data-i18n-empty]')) el.dataset.empty = t(el.dataset.i18nEmpty);
}
