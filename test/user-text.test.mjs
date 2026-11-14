import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AUTO_ERRORS } from '../src/autosetup.mjs';
import { MESSAGES } from '../src/setup.mjs';
import { NOTES, UPGRADE_ERRORS } from '../src/update.mjs';
import { NOTHING_LEFT } from '../src/autosetup.mjs';

// Text a beginner reads must say something true and specific: no placeholder wording, no leftover test text.
const root = path.resolve(import.meta.dirname, '..');
const PLACEHOLDER = /\b(the one thing|one thing left|the thing|todo|fixme|lorem|placeholder|tbd|xxx|something went wrong)\b|\.{3}(?!\w)|\u2026/i;

const js = source => [...source.matchAll(/(['`])((?:\\.|(?!\1)[^\\\r\n]){12,})\1/g)].map(m => m[2]).filter(line => !line.includes('${'));

test('the sentences of the pots commands contain no placeholder-like text', async () => {
  const helper = await fs.readFile(path.join(root, 'src', 'cli.mjs'), 'utf8');
  for (const line of js(helper)) assert.ok(!PLACEHOLDER.test(line), `cli.mjs: ${line}`);
});

test('every message Setup can show comes from a list that has no placeholder text and ends in plain words', () => {
  const lists = { AUTO_ERRORS, MESSAGES: Object.values(MESSAGES), NOTES: Object.values(NOTES), UPGRADE_ERRORS: Object.values(UPGRADE_ERRORS) };
  for (const [name, rows] of Object.entries(lists)) for (const row of rows) assert.ok(!PLACEHOLDER.test(row), `${name}: ${row}`);
  assert.equal(NOTHING_LEFT, 'Nothing else to do.');
});

test('the docs and quickstart quote no placeholder text', async () => {
  for (const name of ['README.md', 'docs/release-quickstart.md', 'docs/windows-setup.md', 'docs/client-setup.md']) {
    const text = await fs.readFile(path.join(root, name), 'utf8');
    assert.ok(!/do the one thing|one thing left|Connect assistants again/i.test(text), name);
  }
});
