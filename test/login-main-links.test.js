import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('login company and privacy links leave the Hub host for the canonical main site', () => {
  const html = readFileSync(new URL('../public/login.html', import.meta.url), 'utf8');
  const links = [...html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
  assert.equal(links.length, 3);
  const expected = ['https://kolobovdjp.org/', 'https://kolobovdjp.org/privacy/', 'https://kolobovdjp.org/'];
  assert.deepEqual(links.map(match => match[1]), expected);
  for (const page of ['https://hub.kolobovdjp.org/hub/login/', 'https://hub.kolobovdjp.org/hub/login.html']) {
    assert.deepEqual(links.map(match => new URL(match[1], page).href), expected);
  }
  // Login assets and API script remain on the authenticated Hub origin.
  assert.match(html, /src="\/hub\/login\.js"/);
  assert.match(html, /href="\/hub\/login\.css"/);
});
