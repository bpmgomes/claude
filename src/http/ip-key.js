import { isIPv4, isIPv6 } from 'node:net';

const V4_MAPPED_RE = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/** Expande um IPv6 (com '::' e IPv4 embutido no fim) em 8 grupos hexadecimais. */
function expandIPv6(ip) {
  let text = ip.toLowerCase();
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);
  // IPv4 embutido no fim (ex.: 64:ff9b::1.2.3.4) vira dois grupos.
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (isIPv4(tail)) {
    const [a, b, c, d] = tail.split('.').map(Number);
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, rest] = text.includes('::') ? text.split('::') : [text, null];
  const left = head ? head.split(':') : [];
  const right = rest ? rest.split(':') : [];
  const fill = rest === null ? [] : Array(8 - left.length - right.length).fill('0');
  return [...left, ...fill, ...right].map((g) => g.replace(/^0+(?=.)/, ''));
}

/**
 * Chave de rate limit por IP: IPv4 (inclusive ::ffff:a.b.c.d) como está; IPv6 agrupado no /64.
 * '2001:db8:1:2:aaaa::1' -> '2001:db8:1:2::/64'; entrada inválida -> 'ip:unknown'.
 * Só para as rotas públicas: o login continua com normalizeIp (AF-02 item 1, R8).
 * @param {unknown} ip
 * @returns {string}
 */
export function rateLimitKey(ip) {
  if (typeof ip !== 'string') return 'ip:unknown';
  if (isIPv4(ip)) return ip;
  const mapped = ip.match(V4_MAPPED_RE);
  if (mapped && isIPv4(mapped[1])) return mapped[1];
  if (!isIPv6(ip)) return 'ip:unknown';
  return `${expandIPv6(ip).slice(0, 4).join(':')}::/64`;
}
