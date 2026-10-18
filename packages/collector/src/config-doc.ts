/**
 * The settings table of docs/CONFIG.md, built from settings-schema.json (scripts/config-doc.ts
 * writes it; packages/collector/test/config-doc.test.ts checks it is current).
 */

import { SPECS } from './prefs.ts';

const SECTION: Record<string, string> = {
  general: 'General', appearance: 'Appearance', behaviour: 'Behaviour', sensors: 'Sensors', chat: 'Chat',
};

function range(spec: (typeof SPECS)[number]): string {
  if (spec.values) return spec.values.map((v) => `\`${v}\``).join(' · ');
  if (spec.type === 'bool') return '`true` · `false`';
  if (spec.type === 'id') return 'an avatar id';
  if (spec.type === 'point') return '`{x, y}`';
  return `${spec.min}–${spec.max}${spec.step ? ` (step ${spec.step})` : ''}`;
}

function where(spec: (typeof SPECS)[number]): string {
  if (spec.nativeOnly) return 'set by the widget';
  if (spec.nativeOnlyTrue) return 'panel (off only), menu (on, with confirmation), file';
  return spec.section ? 'panel, file' : 'file';
}

export function settingsTable(): string {
  const rows = SPECS.map((spec) => {
    const def = spec.default === null ? 'preset / engine default' : `\`${JSON.stringify(spec.default)}\``;
    const section = spec.section ? SECTION[spec.section] : '—';
    return `| ${section} | \`${spec.path}\` | ${range(spec)} | ${def} | ${where(spec)} | ${spec.doc} |`;
  });
  return ['| Section | In `config.json` | Values | Default | Where | What it does |',
          '|---|---|---|---|---|---|', ...rows, ''].join('\n');
}
