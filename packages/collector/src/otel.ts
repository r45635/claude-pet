#!/usr/bin/env node
/**
 * The OpenTelemetry source (opt-in): Claude Code's own telemetry, exported to the daemon as
 * OTLP/HTTP JSON logs. It gives real output-token counts per API request, in every client —
 * the VS Code extension included, where the status line never runs — without reading any
 * conversation file.
 *
 * Measured (2026-10-19, Claude Code 2.1.301): one `claude_code.api_request` log record per API
 * request, emitted when the request ends, batched every OTEL_LOGS_EXPORT_INTERVAL; it carries
 * `session.id` (whose first 8 characters are the hooks' `sid`), `output_tokens`, `duration_ms`.
 * The same batches also carry the user's e-mail, account and organization ids, and prompt and
 * response lengths: **everything is dropped** except those numbers — the parser below builds
 * its output from an allow-list, like the hook script. Nothing is logged, nothing stored.
 *
 * Wiring: `claude-pet otel enable` adds five variables to the `env` block of
 * ~/.claude/settings.json (backed up first), only the logs signal's, so a metrics exporter the
 * user already has is left alone; it refuses when the user's own logs exporter is configured.
 * `disable` removes exactly what `enable` added. New Claude Code sessions pick it up.
 *
 *   claude-pet otel [status|enable|disable]      (clone: npm run otel -- …)
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMain } from './entry.ts';
import { settingsPath, writeSettings, type Settings } from './install.ts';
import { ROOT_DIR } from './paths.ts';
import { applyPatch, ConfigFileError, readUserFile, writeUserFile } from './prefs.ts';

/** One API request's output, as the engine needs it. Nothing else crosses this line. */
export type OtelSignal = { sid: string; atMs: number; outTokens: number };

/** Records looked at per request: a bound, not a sample (a batch is a few dozen). */
const MAX_RECORDS = 5_000;

type AnyValue = { stringValue?: unknown; intValue?: unknown; doubleValue?: unknown };
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const field = (o: unknown, k: string): unknown => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined);

function str(v: unknown): string | null {
  const s = field(v, 'stringValue');
  return typeof s === 'string' ? s : null;
}
/** OTLP JSON encodes int64 as a string or a number; doubles as numbers. */
function num(v: unknown): number | null {
  for (const k of ['intValue', 'doubleValue'] as const) {
    const raw = (v as AnyValue | undefined)?.[k];
    const n = typeof raw === 'string' && /^-?\d+$/.test(raw) ? Number(raw) : raw;
    if (typeof n === 'number' && Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * OTLP logs (ExportLogsServiceRequest, JSON) → the api_request records' session, time and
 * output tokens. Never throws; anything it does not fully understand is skipped.
 */
export function parseOtlpLogs(body: unknown): OtelSignal[] {
  const out: OtelSignal[] = [];
  let seen = 0;
  for (const rl of arr(field(body, 'resourceLogs'))) {
    for (const sl of arr(field(rl, 'scopeLogs'))) {
      for (const rec of arr(field(sl, 'logRecords'))) {
        if (++seen > MAX_RECORDS) return out;
        const attrs = new Map<string, unknown>();
        for (const a of arr(field(rec, 'attributes'))) {
          const key = field(a, 'key');
          if (typeof key === 'string') attrs.set(key, field(a, 'value'));
        }
        if (str(attrs.get('event.name')) !== 'api_request') continue;
        const sid = (str(attrs.get('session.id')) ?? '').slice(0, 8);
        if (!/^[A-Za-z0-9-]{8}$/.test(sid)) continue;
        const outTokens = num(attrs.get('output_tokens'));
        if (outTokens === null || outTokens < 0) continue;
        let atMs = Date.parse(str(attrs.get('event.timestamp')) ?? '');
        if (!Number.isFinite(atMs)) {
          const nano = field(rec, 'timeUnixNano');
          atMs = typeof nano === 'string' && /^\d+$/.test(nano) ? Number(BigInt(nano) / 1_000_000n) : NaN;
        }
        if (!Number.isFinite(atMs)) continue;
        out.push({ sid, atMs, outTokens: Math.min(Math.round(outTokens), 1_000_000) });
      }
    }
  }
  return out;
}

// ---- the env block in ~/.claude/settings.json ------------------------------------------------

/** What `enable` writes: the logs signal only, as OTLP/HTTP JSON to this daemon. */
export function otelEnv(port: number): Record<string, string> {
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `http://127.0.0.1:${port}/v1/logs`,
    OTEL_LOGS_EXPORT_INTERVAL: '2000',
  };
}

export type OtelEnvState =
  | { state: 'off' }
  | { state: 'on' }
  /** Some of ours, not all (a hand edit, another port): `enable` repairs it. */
  | { state: 'partial'; missing: string[] }
  /** The user's own telemetry uses a key we need: never overwritten. */
  | { state: 'conflict'; keys: string[] };

const envOf = (s: Settings): Record<string, unknown> =>
  s.env && typeof s.env === 'object' && !Array.isArray(s.env) ? (s.env as Record<string, unknown>) : {};

/** Our endpoint on any port: the daemon moved to another port is ours to repoint, not a conflict. */
const isOurEndpoint = (v: unknown): boolean => typeof v === 'string' && /^http:\/\/127\.0\.0\.1:\d+\/v1\/logs$/.test(v);
const isOurs = (k: string, v: unknown, want: Record<string, string>): boolean =>
  v === want[k] || (k === 'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT' && isOurEndpoint(v));

/** Keys we need that the user already set to something else. */
function conflicts(env: Record<string, unknown>, want: Record<string, string>): string[] {
  return Object.keys(want).filter((k) => k in env && !isOurs(k, env[k], want));
}

export function otelEnvState(settings: Settings, port: number): OtelEnvState {
  const env = envOf(settings);
  const want = otelEnv(port);
  const clash = conflicts(env, want);
  if (clash.length > 0) return { state: 'conflict', keys: clash };
  const missing = Object.keys(want).filter((k) => env[k] !== want[k]);
  if (missing.length === 0) return { state: 'on' };
  // Telemetry switched on for the user's own metrics is not "partly ours".
  const ours = Object.keys(want).filter((k) => k !== 'CLAUDE_CODE_ENABLE_TELEMETRY' && k in env);
  return ours.length === 0 ? { state: 'off' } : { state: 'partial', missing };
}

export type EnvPlan = { settings: Settings; changes: string[]; error?: string };

export function planOtelEnable(input: Settings, port: number): EnvPlan {
  const settings = structuredClone(input);
  const env = { ...envOf(settings) };
  const want = otelEnv(port);
  const clash = conflicts(env, want);
  if (clash.length > 0) {
    return { settings: input, changes: [], error: `your own telemetry settings use ${clash.join(', ')}: left untouched. ` +
      'claude-pet needs the logs signal sent as OTLP/HTTP JSON to the daemon; see docs/CLAUDE_CODE_TELEMETRY.md (OTEL).' };
  }
  const changes: string[] = [];
  for (const [k, v] of Object.entries(want)) {
    if (env[k] === v) continue;
    changes.push(`${k in env ? '~' : '+'} env.${k}`);
    env[k] = v;
  }
  settings.env = env;
  return { settings, changes };
}

export function planOtelDisable(input: Settings, port: number): EnvPlan {
  const settings = structuredClone(input);
  const env = { ...envOf(settings) };
  const want = otelEnv(port);
  const changes: string[] = [];
  for (const k of Object.keys(want)) {
    if (k === 'CLAUDE_CODE_ENABLE_TELEMETRY') continue;
    if (k in env && isOurs(k, env[k], want)) {
      delete env[k];
      changes.push(`- env.${k}`);
    }
  }
  // Telemetry stays on if the user exports anything else (their own metrics, say).
  if (changes.length > 0 && env.CLAUDE_CODE_ENABLE_TELEMETRY === '1' && !Object.keys(env).some((k) => k.startsWith('OTEL_'))) {
    delete env.CLAUDE_CODE_ENABLE_TELEMETRY;
    changes.push('- env.CLAUDE_CODE_ENABLE_TELEMETRY');
  }
  if (Object.keys(env).length > 0) settings.env = env;
  else delete settings.env;
  return { settings, changes };
}

/** The daemon's port: its last endpoint.json, else CLAUDE_PET_PORT, else 8787. */
export function daemonPort(): number {
  try {
    const url = JSON.parse(readFileSync(join(ROOT_DIR, 'endpoint.json'), 'utf8')).url as string;
    const port = Number(new URL(url).port);
    if (port > 0) return port;
  } catch { /* the default */ }
  return Number(process.env.CLAUDE_PET_PORT ?? 8787);
}

/** The pet's own switch (ui.sensors.otel), so the daemon starts listening. */
function setPref(on: boolean): void {
  try {
    writeUserFile(applyPatch(readUserFile(), { otel: on }));
  } catch (err) {
    if (!(err instanceof ConfigFileError)) throw err;
    process.stderr.write(`⚠️  ~/.claude-pet/config.json is unreadable, so the setting was not changed: ${err.message}\n`);
  }
}

export function main(argv: string[]): number {
  const mode = argv.find((a) => ['status', 'enable', 'disable'].includes(a)) ?? 'status';
  const file = settingsPath(argv);
  let settings: Settings = {};
  try {
    settings = JSON.parse(readFileSync(file, 'utf8')) as Settings;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      process.stderr.write(`${file} is unreadable, left untouched: ${(err as Error).message}\n`);
      return 1;
    }
  }
  const port = daemonPort();
  if (mode === 'status') {
    const s = otelEnvState(settings, port);
    const words = { off: 'off', on: `on — Claude Code sends its logs to http://127.0.0.1:${port}/v1/logs`,
                    partial: 'partly configured — run `claude-pet otel enable` to repair', conflict: 'blocked by your own telemetry settings' };
    process.stdout.write(`OpenTelemetry source: ${words[s.state]}${s.state === 'conflict' ? ` (${s.keys.join(', ')})` : ''}\n`);
    return 0;
  }
  const plan = mode === 'enable' ? planOtelEnable(settings, port) : planOtelDisable(settings, port);
  if (plan.error) {
    process.stderr.write(`${plan.error}\n`);
    return 1;
  }
  if (plan.changes.length > 0) {
    process.stdout.write(`${mode} → ${file}\n${plan.changes.map((c) => `  ${c}`).join('\n')}\n`);
    writeSettings(file, plan.settings);
  } else {
    process.stdout.write(`${file} is already in the wanted state\n`);
  }
  setPref(mode === 'enable');
  process.stdout.write(mode === 'enable'
    ? 'New Claude Code sessions will send their token counts to the pet (sessions already open keep their environment).\n'
    : 'The pet no longer receives OpenTelemetry; new sessions stop sending it.\n');
  return 0;
}

if (isMain(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
