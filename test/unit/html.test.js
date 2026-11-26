import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, html, SafeHtml } from '../../src/http/html.js';

describe('escapeHtml (AF-09, critério 18)', () => {
  test('& < > " \' ` viram entidades', () => {
    assert.equal(escapeHtml(`& < > " ' \``), '&amp; &lt; &gt; &quot; &#39; &#96;');
  });

  test('null e undefined viram vazio; número vira texto', () => {
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
    assert.equal(escapeHtml(42), '42');
  });
});

describe('html``', () => {
  test('escapa string, número, array e valor aninhado', () => {
    const name = '<b>Ana</b>';
    const out = html`<p title="${name}">${name} ${7} ${['<i>', 'x']} ${html`<em>${'&'}</em>`}</p>`;
    assert.ok(out instanceof SafeHtml);
    assert.equal(
      out.toString(),
      '<p title="&lt;b&gt;Ana&lt;/b&gt;">&lt;b&gt;Ana&lt;/b&gt; 7 &lt;i&gt;x <em>&amp;</em></p>',
    );
  });

  test('SafeHtml não é escapado de novo, nem dentro de array', () => {
    const inner = html`<li>${'a<b'}</li>`;
    assert.equal(html`<ul>${[inner, inner]}</ul>`.toString(), '<ul><li>a&lt;b</li><li>a&lt;b</li></ul>');
    assert.equal(html`${inner}`.toString(), inner.toString());
  });

  test('null, undefined e false viram vazio; 0 continua', () => {
    assert.equal(html`[${null}${undefined}${false}${0}]`.toString(), '[0]');
  });

  for (const payload of ['<script>alert(1)</script>', '"><img src=x onerror=alert(1)>']) {
    test(`${payload} sai sem nenhum < ou " literal`, () => {
      const out = html`${payload}`.toString();
      assert.equal(out.includes('<'), false);
      assert.equal(out.includes('"'), false);
      assert.equal(out.includes('>'), false);
    });
  }
});
