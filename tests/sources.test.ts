import assert from 'node:assert/strict';
import test from 'node:test';
import { notionId } from '../packages/shared/src/sources.js';

const id = '0123abcd-0123-4567-89ab-0123456789ab';
const compact = id.replace(/-/g, '');

test('a Notion page or database is named by its link or its id, dashed or not', () => {
  for (const value of [id, compact, compact.toUpperCase(), ` ${id} `,
    `https://www.notion.so/${compact}`, `https://notion.so/acme/Specs-${compact}`, `https://www.notion.so/acme/Specs-${compact}?pvs=4`,
    `https://acme.notion.site/Public-page-${compact}`, `https://www.notion.so/acme/${id}`,
    // A page opened from a database view is the page in ?p=, not the database.
    `https://www.notion.so/acme/${'f'.repeat(32)}?v=${'e'.repeat(32)}&p=${compact}`]) {
    assert.equal(notionId(value), id, value);
  }
});

test('a title slug never becomes part of the id, and other inputs are refused', () => {
  // The slug ends in hex digits: only the last 32 hex digits, after a dash, are the id.
  assert.equal(notionId(`https://www.notion.so/Cafe-deadbeef-${compact}`), id);
  for (const value of ['', 'Specs', compact.slice(1), `${compact}0`, `x${compact}`, `https://example.com/${compact}`, `http://www.notion.so/${compact}`,
    `https://www.notion.so/Specs${compact}`, `https://evil.example/notion.so/${compact}`, 42, null, 'a'.repeat(3000)]) {
    assert.equal(notionId(value), null, String(value).slice(0, 80));
  }
});
