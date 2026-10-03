import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin');
const HOOK = join(BIN, 'claude-pet-hook.sh');
const STATUSLINE = join(BIN, 'claude-pet-statusline.sh');

const CANARY = 'CANARY_c7f41e9a';

/** Run a bin script with an isolated CLAUDE_PET_HOME and return [stdout, spool]. */
function run(script: string, payload: unknown): { stdout: string; spool: string } {
  const home = mkdtempSync(join(tmpdir(), 'claude-pet-priv-'));
  const stdout = execFileSync('sh', [script], {
    input: JSON.stringify(payload),
    env: { ...process.env, CLAUDE_PET_HOME: home },
    encoding: 'utf8',
  });
  const file = join(home, 'spool', 'events.jsonl');
  return { stdout, spool: existsSync(file) ? readFileSync(file, 'utf8') : '' };
}

/** Realistic hook payloads, every sensitive field poisoned with the canary. */
const PAYLOADS: { event: string; expect: string | null; payload: Record<string, unknown> }[] = [
  {
    event: 'PreToolUse',
    expect: 'BASH_STARTED',
    payload: {
      hook_event_name: 'PreToolUse',
      session_id: '0123abcd-ffff-0000-1111-222233334444',
      transcript_path: `/Users/x/.claude/projects/${CANARY}/s.jsonl`,
      cwd: `/Users/x/Github/${CANARY}-client-repo`,
      tool_name: 'Bash',
      tool_use_id: 'toolu_01',
      tool_input: { command: `rm -rf ${CANARY}`, description: CANARY },
    },
  },
  {
    event: 'PostToolUse',
    expect: 'TOOL_FINISHED',
    payload: {
      hook_event_name: 'PostToolUse',
      session_id: '0123abcd',
      tool_name: 'Read',
      tool_input: { file_path: `/secret/${CANARY}.ts` },
      tool_result: `file content: ${CANARY}`,
    },
  },
  {
    event: 'PostToolUseFailure',
    expect: 'ERROR',
    payload: {
      hook_event_name: 'PostToolUseFailure',
      session_id: '0123abcd',
      tool_name: 'Edit',
      error: `ENOENT ${CANARY}`,
    },
  },
  {
    event: 'UserPromptSubmit',
    expect: 'PROMPT_SUBMITTED',
    payload: {
      hook_event_name: 'UserPromptSubmit',
      session_id: '0123abcd',
      prompt: `please refactor ${CANARY} and the password is ${CANARY}`,
    },
  },
  {
    event: 'Stop',
    expect: 'TURN_COMPLETED',
    payload: {
      hook_event_name: 'Stop',
      session_id: '0123abcd',
      last_assistant_message: `here is the code: ${CANARY}`,
    },
  },
  {
    event: 'StopFailure',
    expect: 'ERROR',
    payload: {
      hook_event_name: 'StopFailure',
      session_id: '0123abcd',
      error_type: 'rate_limit',
      error_message: CANARY,
    },
  },
  {
    event: 'MessageDisplay',
    expect: 'OUTPUT_STREAMING',
    payload: {
      hook_event_name: 'MessageDisplay',
      session_id: '0123abcd',
      message_text: CANARY,
      message_id: 'msg_1',
    },
  },
  {
    event: 'SubagentStart',
    expect: 'SUBAGENT_STARTED',
    payload: {
      hook_event_name: 'SubagentStart',
      session_id: '0123abcd',
      agent_type: 'Explore',
      agent_id: 'ag_1',
      task_description: `find ${CANARY}`,
    },
  },
  {
    event: 'PermissionRequest',
    expect: 'PERMISSION_WAITING',
    payload: {
      hook_event_name: 'PermissionRequest',
      session_id: '0123abcd',
      tool_name: 'Bash',
      tool_input: { command: CANARY },
      permission_rule: CANARY,
    },
  },
  {
    event: 'SessionEnd',
    expect: 'SESSION_ENDED',
    payload: { hook_event_name: 'SessionEnd', session_id: '0123abcd', end_reason: 'clear' },
  },
  {
    // An MCP tool name is itself sensitive: it can name a vendor or a customer.
    event: 'PreToolUse (mcp)',
    expect: 'TOOL_STARTED',
    payload: {
      hook_event_name: 'PreToolUse',
      session_id: '0123abcd',
      tool_name: `mcp__${CANARY}__get_customer_pii`,
      tool_input: {},
    },
  },
];

for (const { event, expect, payload } of PAYLOADS) {
  test(`hook: ${event} leaks nothing and emits ${expect}`, () => {
    const { spool } = run(HOOK, payload);
    assert.ok(spool.length > 0, 'the hook should have written a line');
    assert.ok(
      !spool.includes(CANARY),
      `canary leaked into the spool for ${event}:\n${spool}`,
    );
    assert.ok(spool.includes(`"type":"${expect}"`), `expected ${expect}, got:\n${spool}`);
  });
}

test('hook: an event with no activity signal writes nothing at all', () => {
  const { spool } = run(HOOK, {
    hook_event_name: 'InstructionsLoaded',
    session_id: '0123abcd',
    file_path: `/Users/x/${CANARY}/CLAUDE.md`,
  });
  assert.equal(spool, '', 'an unmapped hook must stay silent rather than guess');
});

// The subagent tool was renamed Task → Agent; both must classify as `task`, not `other`.
for (const toolName of ['Agent', 'Task']) {
  test(`hook: the ${toolName} tool classifies as task`, () => {
    const { spool } = run(HOOK, {
      hook_event_name: 'PreToolUse',
      session_id: '0123abcd',
      tool_name: toolName,
      tool_input: { prompt: CANARY, subagent_type: 'Explore' },
    });
    assert.ok(!spool.includes(CANARY), `canary leaked:\n${spool}`);
    assert.equal(JSON.parse(spool.trim()).tool, 'task');
  });
}

test('hook: a malformed payload exits 0 and writes nothing', () => {
  const home = mkdtempSync(join(tmpdir(), 'claude-pet-priv-'));
  const stdout = execFileSync('sh', [HOOK], {
    input: 'this is not json at all',
    env: { ...process.env, CLAUDE_PET_HOME: home },
    encoding: 'utf8',
  });
  assert.equal(stdout, '', 'the hook must never print to a tool-call stdout');
  const file = join(home, 'spool', 'events.jsonl');
  assert.ok(!existsSync(file) || readFileSync(file, 'utf8') === '');
});

test('statusline: prints a line AND emits a meter sample, leaking nothing', () => {
  const { stdout, spool } = run(STATUSLINE, {
    session_id: '0123abcd-ffff',
    model: { id: 'claude-opus-5', display_name: 'Opus' },
    workspace: { current_dir: `/Users/x/Github/${CANARY}-repo`, project_dir: '/Users/x' },
    cost: { total_cost_usd: 1.2345, total_duration_ms: 45000, total_api_duration_ms: 2300,
            total_lines_added: 156, total_lines_removed: 23 },
    context_window: { total_input_tokens: 15500, total_output_tokens: 1200,
                      context_window_size: 200000, used_percentage: 8 },
    effort: { level: 'high' },
    rate_limits: { five_hour: { used_percentage: 23.5 } },
  });

  assert.ok(stdout.length > 0, 'printing nothing would blank the user status bar');
  assert.ok(stdout.includes('Opus'), `status line should name the model, got: ${stdout}`);
  assert.ok(stdout.includes('8%'), `status line should show context, got: ${stdout}`);

  assert.ok(spool.includes('"type":"METER_SAMPLE"'));
  assert.ok(!spool.includes(CANARY), `canary leaked via the status line:\n${spool}`);
  const meter = JSON.parse(spool.trim()).meter;
  assert.equal(meter.context_used_pct, 8);
  assert.equal(meter.cost_usd, 1.2345);
  assert.equal(meter.model, 'claude-opus-5');
});

test('statusline: a null context reports null, never 0%', () => {
  const { stdout, spool } = run(STATUSLINE, {
    session_id: 'abcd',
    model: { id: 'claude-opus-5', display_name: 'Opus' },
    context_window: { current_usage: null },
  });
  assert.ok(stdout.includes('ctx —'), `unknown context must render as unknown: ${stdout}`);
  const meter = JSON.parse(spool.trim()).meter;
  assert.equal(meter.context_used_pct, null);
  assert.equal(meter.in_tokens, null, 'absent must stay absent, not become 0');
});
