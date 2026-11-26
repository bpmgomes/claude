import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MANAGE_PAGE_HTML } from '../../src/modules/appointments/manage-page.render.js';
import { tagsOf } from '../helpers/html.js';

test('MANAGE_PAGE_HTML: um módulo, o CSS público, noindex, sem inline nem recurso externo (critério 13)', async () => {
  const html = MANAGE_PAGE_HTML.toString('utf8');
  const scripts = tagsOf(html, 'script');
  assert.deepEqual(scripts, [{ type: 'module', src: '/js/manage-page.js' }]);
  assert.ok(tagsOf(html, 'link').some((l) => l.rel === 'stylesheet' && l.href === '/css/public.css'));
  assert.ok(tagsOf(html, 'meta').some((m) => m.name === 'robots' && m.content === 'noindex'));
  assert.doesNotMatch(html, /\sstyle=/);
  assert.doesNotMatch(html, /\son[a-z]+=/);
  assert.doesNotMatch(html, /<style/);
  assert.doesNotMatch(html, /https?:\/\//);
  assert.doesNotMatch(html, /\{\{|\$\{/);
  assert.match(html, /<title>Seu agendamento · AgendaFácil<\/title>/);
  assert.ok(tagsOf(html, 'div').some((d) => d.class === 'pp-alert mg-alert' && d.role === 'alert'));
  assert.ok(tagsOf(html, 'p').some((p) => p.class === 'mg-live' && p['aria-live'] === 'polite'));
  const fresh = await import(`../../src/modules/appointments/manage-page.render.js?again=${Date.now()}`);
  assert.equal(Buffer.compare(fresh.MANAGE_PAGE_HTML, MANAGE_PAGE_HTML), 0, 'mesmos bytes em duas cargas');
});
