/**
 * The normalized event model. Nothing downstream of this file knows a Claude Code
 * field name, and nothing in this file can hold prompt text, file content, paths or
 * command lines — see docs/PRIVACY.md.
 */

export const SCHEMA_VERSION = 1;

export const EVENT_TYPES = [
  'SESSION_STARTED',
  'PROMPT_SUBMITTED',
  'MODEL_ACTIVE',
  'OUTPUT_STREAMING',
  'FILE_READ',
  'FILE_WRITE',
  'SEARCH',
  'TOOL_STARTED',
  'TOOL_FINISHED',
  'BASH_STARTED',
  'BASH_FINISHED',
  'SUBAGENT_STARTED',
  'SUBAGENT_FINISHED',
  'PERMISSION_WAITING',
  'PERMISSION_RESOLVED',
  'MODEL_IDLE',
  'COMPACTED',
  'TURN_COMPLETED',
  'ERROR',
  'SESSION_ENDED',
  'METER_SAMPLE',
] as const;

export type PetEventType = (typeof EVENT_TYPES)[number];

const EVENT_TYPE_SET: ReadonlySet<string> = new Set(EVENT_TYPES);

/** Closed set of tool classes. An unrecognised tool becomes `other`, never its own name. */
export const TOOL_CLASSES = [
  'bash',
  'read',
  'write',
  'edit',
  'search',
  'fetch',
  'task',
  'todo',
  'notebook',
  'mcp',
  'other',
] as const;

export type ToolClass = (typeof TOOL_CLASSES)[number];

const TOOL_CLASS_SET: ReadonlySet<string> = new Set(TOOL_CLASSES);

/** Gauges sampled from the statusLine payload. Every field is nullable by design. */
export type MeterSample = {
  context_used_pct: number | null;
  context_window: number | null;
  in_tokens: number | null;
  out_tokens: number | null;
  cost_usd: number | null;
  api_ms: number | null;
  wall_ms: number | null;
  lines_added: number | null;
  lines_removed: number | null;
  rate_5h_pct: number | null;
  effort: string | null;
  model: string | null;
};

export type PetEvent = {
  /** Schema version. Lines with another value are dropped, not migrated. */
  v: number;
  /** ISO 8601 with offset. */
  ts: string;
  /** Milliseconds since epoch, derived from `ts` at parse time. */
  tsMs: number;
  type: PetEventType;
  /** sha256(session_id)[0:8] — correlation only. */
  sid?: string;
  /** Parent pid of the hook: leads the daemon to this session's `claude` process. */
  ppid?: number;
  tool?: ToolClass;
  agent?: string;
  /** Subagent id (opaque, ≤ 12 safe chars). Absent on the main thread. */
  aid?: string;
  /** Multiplicity, default 1. */
  n: number;
  /** Duration of a finished tool call, ms. */
  ms?: number;
  /** 'tool' | 'api' for ERROR events. */
  scope?: string;
  /** Closed-enum error code (e.g. `rate_limit`). Never free text. */
  code?: string;
  reason?: string;
  meter?: MeterSample;
};

const METER_KEYS: (keyof MeterSample)[] = [
  'context_used_pct',
  'context_window',
  'in_tokens',
  'out_tokens',
  'cost_usd',
  'api_ms',
  'wall_ms',
  'lines_added',
  'lines_removed',
  'rate_5h_pct',
  'effort',
  'model',
];

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function str(v: unknown, max = 64): string | null {
  return typeof v === 'string' && v.length > 0 ? v.slice(0, max) : null;
}

function parseMeter(raw: unknown): MeterSample | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const out = {} as MeterSample;
  for (const key of METER_KEYS) {
    out[key] = (key === 'effort' || key === 'model' ? str(r[key]) : num(r[key])) as never;
  }
  return out;
}

/**
 * Defensive parse: returns `null` for anything it does not fully understand, and never
 * throws. The caller counts drops; it does not guess.
 *
 * This is also the second privacy allow-list: the returned object is rebuilt from a known
 * key list, so an unexpected field in the input cannot travel any further.
 */
export function parsePetEvent(raw: unknown): PetEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  if (r.v !== SCHEMA_VERSION) return null;

  const type = r.type;
  if (typeof type !== 'string' || !EVENT_TYPE_SET.has(type)) return null;

  const ts = typeof r.ts === 'string' ? r.ts : null;
  if (!ts) return null;
  const tsMs = Date.parse(ts);
  if (!Number.isFinite(tsMs)) return null;

  const event: PetEvent = {
    v: SCHEMA_VERSION,
    ts,
    tsMs,
    type: type as PetEventType,
    n: 1,
  };

  const n = num(r.n);
  if (n !== null && n > 0) event.n = Math.min(Math.floor(n), 1000);

  const sid = str(r.sid, 16);
  if (sid) event.sid = sid;

  const ppid = num(r.ppid);
  if (ppid !== null && Number.isInteger(ppid) && ppid > 1) event.ppid = ppid;

  if (typeof r.tool === 'string') {
    event.tool = (TOOL_CLASS_SET.has(r.tool) ? r.tool : 'other') as ToolClass;
  }

  const agent = str(r.agent, 48);
  if (agent) event.agent = agent.toLowerCase();

  const aid = str(r.aid, 12);
  if (aid && /^[A-Za-z0-9_-]+$/.test(aid)) event.aid = aid;

  const ms = num(r.ms);
  if (ms !== null && ms >= 0) event.ms = ms;

  const scope = str(r.scope, 16);
  if (scope) event.scope = scope;

  const code = str(r.code, 48);
  if (code) event.code = code;

  const reason = str(r.reason, 48);
  if (reason) event.reason = reason;

  if (type === 'METER_SAMPLE') {
    const meter = parseMeter(r.meter);
    if (!meter) return null;
    event.meter = meter;
  }

  return event;
}

/** Parse one spool line. Returns `null` on malformed JSON — by design, not by accident. */
export function parseSpoolLine(line: string): PetEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  try {
    return parsePetEvent(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

/**
 * Serialize for the spool. `tsMs` is derived at parse time and is deliberately not
 * written: one source of truth for the timestamp, and a shorter line in the hot path.
 */
export function serializePetEvent(event: PetEvent): string {
  const out: Record<string, unknown> = { v: SCHEMA_VERSION, ts: event.ts, type: event.type };
  if (event.sid) out.sid = event.sid;
  if (event.tool) out.tool = event.tool;
  if (event.agent) out.agent = event.agent;
  if (event.aid) out.aid = event.aid;
  if (event.n !== 1) out.n = event.n;
  if (event.ms !== undefined) out.ms = event.ms;
  if (event.scope) out.scope = event.scope;
  if (event.code) out.code = event.code;
  if (event.reason) out.reason = event.reason;
  if (event.meter) out.meter = event.meter;
  return JSON.stringify(out);
}
