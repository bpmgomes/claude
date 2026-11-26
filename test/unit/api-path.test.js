import { test } from 'node:test';
import assert from 'node:assert/strict';
import { areaOf, isApiRequest } from '../../src/http/api-path.js';

test('areaOf: primeiro segmento decodificado, só se seguido de /', () => {
  const cases = [
    ['/api/business', 'api'],
    ['/%61pi/business', 'api'],
    ['/%61%70%69/x', 'api'],
    ['/a%70i/x', 'api'],
    ['/media/logos/x.png', 'media'],
    ['/%73hared/x.js', 'shared'],
    ['/api', null],
    ['/api?x=/y', null],
    ['/API/x', 'API'],
    ['//api/x', null],
    ['/%2Fapi/x', '/api'],
    ['/%E0%A4%A/x', null],
    [`/${'a'.repeat(10_000)}/x`, null],
    ['api/x', null],
    [undefined, null],
  ];
  for (const [url, expected] of cases) assert.equal(areaOf(url), expected, String(url).slice(0, 30));
});

test('isApiRequest: rota casada de /api/ ou caminho decodificado', () => {
  assert.equal(isApiRequest({ raw: { url: '/%61pi/x' } }), true);
  assert.equal(isApiRequest({ raw: { url: '/x' }, routeOptions: { url: '/api/business' } }), true);
  assert.equal(isApiRequest({ raw: { url: '/salao' }, routeOptions: { url: '/:slug' } }), false);
  assert.equal(isApiRequest({ url: '/api/x' }), true);
  assert.equal(isApiRequest({ raw: { url: '/media/logos/a' }, routeOptions: { url: '/media/logos/:file' } }), false);
});
