import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TranscriptSignal } from '@claude-pet/core';
import { parseTranscriptLine, threadOf, TranscriptSource } from '../src/transcript.ts';

const CANARY = `CANARY_${Math.random().toString(36).slice(2)}`;
const SID = '0123abcd-0000-4000-8000-000000000000';

// Shapes as Claude Code writes them (key order matters: user lines put `type` first).
const userPrompt = () => JSON.stringify({ parentUuid: null, isSidechain: false, promptId: 'p1', type: 'user',
  message: { role: 'user', content: `${CANARY} secret prompt` }, uuid: 'u1', timestamp: '2026-10-05T10:00:00.000Z' });
const toolResult = () => JSON.stringify({ parentUuid: 'x', isSidechain: false, promptId: 'p1', type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', content: `${CANARY} file contents` }] },
  uuid: 'u2', timestamp: '2026-10-05T10:00:01.000Z', toolUseResult: { stdout: CANARY } });
const assistant = (block: Record<string, unknown>, out: number, req = 'req_1') => JSON.stringify({
  parentUuid: 'y', isSidechain: false,
  message: { role: 'assistant', content: [block], usage: { input_tokens: 3, output_tokens: out } },
  requestId: req, type: 'assistant', uuid: 'a1', timestamp: '2026-10-05T10:00:02.000Z', cwd: `/Users/x/${CANARY}` });

test('transcript lines: input, thinking, text, tool_use; anything else is nothing', () => {
  assert.deepEqual(parseTranscriptLine(userPrompt()), { kind: 'input' });
  assert.deepEqual(parseTranscriptLine(toolResult()), { kind: 'input' });
  assert.deepEqual(parseTranscriptLine(assistant({ type: 'thinking', thinking: CANARY }, 3)),
    { kind: 'thinking', out: 3, req: 'req_1' });
  assert.deepEqual(parseTranscriptLine(assistant({ type: 'text', text: CANARY }, 120)),
    { kind: 'text', out: 120, req: 'req_1' });
  assert.equal(parseTranscriptLine(assistant({ type: 'tool_use', name: 'Bash', input: { command: CANARY } }, 130))?.kind,
    'tool_use');
  assert.equal(parseTranscriptLine(JSON.stringify({ type: 'ai-title', title: CANARY })), null);
  assert.equal(parseTranscriptLine('{"type":"assistant", broken'), null);
});

test('transcript files: main thread and subagents named as the hooks name them', () => {
  assert.deepEqual(threadOf(`/p/proj/${SID}.jsonl`), { sid: '0123abcd', aid: null });
  assert.deepEqual(threadOf(`/p/proj/${SID}/subagents/agent-af635f9817debcf75.jsonl`),
    { sid: '0123abcd', aid: 'af635f9817de' });
  assert.equal(threadOf('/p/proj/notes.jsonl'), null);
  assert.equal(threadOf(`/p/proj/${SID}/elsewhere/agent-x.jsonl`), null);
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'pet-transcript-'));
  const dir = join(root, '-Users-x');
  mkdirSync(join(dir, SID, 'subagents'), { recursive: true });
  return { root, main: join(dir, `${SID}.jsonl`), agent: join(dir, SID, 'subagents', 'agent-af635f9817debcf75.jsonl') };
}

const settle = () => new Promise((r) => setTimeout(r, 300)); // let FSEvents deliver

test('transcript source: no history, only new lines, tokens counted once per request', async () => {
  const { root, main, agent } = setup();
  writeFileSync(main, `${userPrompt()}\n${assistant({ type: 'text', text: 'old' }, 999, 'old')}\n`);
  const source = new TranscriptSource(root);
  assert.ok(source.start());
  try {
    await settle();
    appendFileSync(main, `${toolResult()}\n`);
    appendFileSync(main, `${assistant({ type: 'text', text: CANARY }, 230)}\n${assistant({ type: 'tool_use', name: 'Read', input: {} }, 230)}\n`);
    writeFileSync(agent, `${userPrompt()}\n${assistant({ type: 'thinking', thinking: CANARY }, 5, 'req_a')}\n`);
    await settle();
    const signals: TranscriptSignal[] = [];
    source.drain((s) => signals.push(s));
    const strip = signals.map(({ atMs: _, ...rest }) => rest);
    assert.deepEqual(strip, [
      { sid: '0123abcd', aid: null, kind: 'input' },
      { sid: '0123abcd', aid: null, kind: 'text', outTokens: 230 },
      { sid: '0123abcd', aid: null, kind: 'tool_use' }, // same request: its tokens were counted
      { sid: '0123abcd', aid: 'af635f9817de', kind: 'input' }, // new file: read from its start
      { sid: '0123abcd', aid: 'af635f9817de', kind: 'thinking', outTokens: 5 },
    ]);
    assert.ok(!JSON.stringify(signals).includes(CANARY), 'no text from a conversation may come out');
  } finally {
    source.stop();
  }
});

test('transcript source: a line split across writes is read once, whole', async () => {
  const { root, main } = setup();
  writeFileSync(main, '');
  const source = new TranscriptSource(root);
  source.start();
  try {
    await settle();
    const line = assistant({ type: 'text', text: 'x' }, 10);
    appendFileSync(main, line.slice(0, 40));
    await settle();
    const signals: TranscriptSignal[] = [];
    source.drain((s) => signals.push(s));
    assert.equal(signals.length, 0);
    appendFileSync(main, `${line.slice(40)}\n`);
    await settle();
    source.drain((s) => signals.push(s));
    assert.deepEqual(signals.map((s) => s.kind), ['text']);
  } finally {
    source.stop();
  }
});

test('transcript source: off means nothing is watched or read', () => {
  const { root } = setup();
  const source = new TranscriptSource(root);
  assert.equal(source.running, false);
  assert.equal(source.drain(() => assert.fail('nothing may be read while off')), 0);
});
