import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

function plain(markdown: string): string {
  return markdown.replace(/[*_`]/g, '').replace(/\s+/g, ' ');
}

// These are operator-facing contracts, like the runbook checks in
// lap-summary-outputs.test.ts. Historical paragraphs may retain old decisions;
// an unqualified setup instruction must not send a compatible user to upgrade.
for (const name of ['RUNNING.md', 'LIVE_TESTING.md', 'TELEMETRY_PROTOCOL.md']) {
  test(`${name} explains field-based telemetry intake without requiring API 3.6 or manual version approval`, async () => {
    const markdown = await readFile(new URL(`../docs/${name}`, import.meta.url), 'utf8');
    const paragraphs = markdown.split(/\r?\n\s*\r?\n/).map(plain);
    // Exempt only individual sentences explicitly labelled as historical.
    // A later current instruction in the same paragraph must still be checked.
    const current = paragraphs.flatMap(paragraph => paragraph.split(/(?<=[.!?])\s+(?=[A-Z])/))
      .filter(sentence => !/^(?:Historical|Superseded)(?:\s+(?:decision|policy|note))?\s*:/i.test(sentence))
      .join('\n');

    assert.doesNotMatch(current,
      /(?<!not )(?<!never )\b(?:only (?:supports?|accepts?) (?:API )?3\.6|(?:supports?|accepts?) only (?:API )?3\.6|(?:supports?|accepts?) (?:API )?3\.6 only)\b/i,
      'Reject exclusive API 3.6 support claims, while allowing nonexclusive support statements');
    assert.doesNotMatch(current,
      /(?<!not )(?<!never )(?<!no )\b(?:upgrade to|must use|requires?|expected|confirm|open an)\s+(?:API\s+|version\s+)?3\.6\b/i,
      'Reject affirmative API 3.6 prerequisites, while allowing statements that it is not required');
    const linkedProtocol = /\]\((?:\.\/)?TELEMETRY_PROTOCOL\.md(?:#[^)]*)?\)/.test(markdown);
    assert.ok(linkedProtocol ||
      /field[ -]based|(?:compatib\w*|accept\w*|admit\w*)[^\n]{0,180}(?:required|used|consumed|usable) fields|(?:required|used|consumed|usable) fields[^\n]{0,180}(?:compatib\w*|accept\w*|admit\w*)/i.test(current),
      'Explain field-based intake or link to the shared protocol guidance');
    if (name === 'TELEMETRY_PROTOCOL.md') {
      assert.match(current, /\b2\.8\b/, 'The shared policy identifies observed compatible input');
      assert.match(current,
        /(?:no|without|not required)[^\n]{0,120}(?:manual[^\n]{0,40}(?:version|approval)|compatibility override)|(?:manual[^\n]{0,40}(?:version|approval)|compatibility override)[^\n]{0,120}(?:not required|unnecessary)/i,
        'The shared policy explains that no manual version approval or override is needed');
      assert.match(current, /live[^\n]{0,140}(?:disabled|unverified|pending|not enabled)/i,
        'The shared policy keeps live-saving limitations transparent');
    }
  });
}

test('the telemetry protocol describes shared field-based intake across HUD, bridge and replay', async () => {
  const markdown = await readFile(new URL('../docs/TELEMETRY_PROTOCOL.md', import.meta.url), 'utf8');
  const current = plain(markdown);
  assert.match(current, /field-based across the normal HUD, browser bridge and replay/i);
  assert.match(current, /not an exact API version or version allowlist/i);
  assert.match(current, /Missing or malformed required fields and unsupported sessions retain specific errors/i);
});
