import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareTags, freshUpdateState, latestTagFromHeaders, parseTag } from '../src/update.ts';

test('update: the latest tag is read from the redirect, not guessed', () => {
  const headers = 'HTTP/2 302\r\nserver: GitHub.com\r\nlocation: https://github.com/r45635/claude-pet/releases/tag/v0.4.0\r\n';
  assert.equal(latestTagFromHeaders(headers), 'v0.4.0');
  assert.equal(latestTagFromHeaders('HTTP/2 302\r\nLocation: /r45635/claude-pet/releases/tag/v1.0.0-rc.1\r\n'), 'v1.0.0-rc.1');
  assert.equal(latestTagFromHeaders('HTTP/2 200\r\nserver: GitHub.com\r\n'), null, 'no redirect, no claim');
  assert.equal(latestTagFromHeaders('location: https://evil.example/releases\r\n'), null);
});

test('update: tags compare as versions, a prerelease is older than its release', () => {
  assert.ok(compareTags('v0.4.0', 'v0.3.0') > 0);
  assert.ok(compareTags('v0.3.0', 'v0.3.1') < 0);
  assert.ok(compareTags('v1.0.0', 'v0.99.99') > 0);
  assert.equal(compareTags('v0.3.0', 'v0.3.0'), 0);
  assert.ok(compareTags('v0.3.0-rc.1', 'v0.3.0') < 0);
  assert.ok(compareTags('v0.3.0', 'v0.3.0-rc.1') > 0);
  assert.equal(compareTags('not-a-tag', 'v0.3.0'), 0, 'unparseable never claims an update');
  assert.equal(parseTag('v1.2'), null);
});

test('update: the fresh state says the layout and the local-build pin out loud', () => {
  const s = freshUpdateState('clone', true);
  assert.equal(s.available, false);
  assert.equal(s.layout, 'clone');
  assert.equal(s.pinnedLocalBuild, true);
  assert.equal(s.installing, false);
  assert.equal(s.error, null);
});
