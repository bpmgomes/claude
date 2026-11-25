import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isSameOriginRequest } from '../../src/http/csrf.js';

const config = { allowedOrigins: [] };

function req(headers = {}) {
  return { method: 'POST', protocol: 'https', host: 'app.example', headers };
}

describe('isSameOriginRequest (critério 21)', () => {
  test('Sec-Fetch-Site same-origin é aceito', () => {
    assert.equal(isSameOriginRequest(req({ 'sec-fetch-site': 'same-origin' }), config), true);
  });

  for (const value of ['cross-site', 'same-site', 'none']) {
    test(`Sec-Fetch-Site ${value} é rejeitado`, () => {
      assert.equal(isSameOriginRequest(req({ 'sec-fetch-site': value }), config), false);
      // Sec-Fetch-Site tem precedência sobre um Origin igual
      assert.equal(
        isSameOriginRequest(req({ 'sec-fetch-site': value, origin: 'https://app.example' }), config),
        false,
      );
    });
  }

  test('Origin igual à própria origem é aceito', () => {
    assert.equal(isSameOriginRequest(req({ origin: 'https://app.example' }), config), true);
  });

  test('Origin diferente é rejeitado (outro host, esquema ou porta)', () => {
    for (const origin of ['https://evil.example', 'http://app.example', 'https://app.example:8443']) {
      assert.equal(isSameOriginRequest(req({ origin }), config), false, origin);
    }
  });

  test('Origin null ou malformado é rejeitado', () => {
    assert.equal(isSameOriginRequest(req({ origin: 'null' }), config), false);
    assert.equal(isSameOriginRequest(req({ origin: 'não é url' }), config), false);
  });

  test('Origin presente em allowedOrigins é aceito', () => {
    const cfg = { allowedOrigins: ['https://admin.example'] };
    assert.equal(isSameOriginRequest(req({ origin: 'https://admin.example' }), cfg), true);
    assert.equal(isSameOriginRequest(req({ origin: 'https://evil.example' }), cfg), false);
  });

  test('sem Sec-Fetch-Site nem Origin é aceito', () => {
    assert.equal(isSameOriginRequest(req(), config), true);
  });
});
