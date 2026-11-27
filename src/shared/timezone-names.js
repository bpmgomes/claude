// Texto único do fuso (AF-23, design 4.1). Puro: sem imports, Intl nem Date. Comentários curtos:
// entra no orçamento de JS da página pública (AF-10, critério 29).

const BR = 'Horário de Brasília';

/** Fusos do Brasil (zone1970.tab), sem deslocamento UTC; conferida contra o tzdata no teste. */
export const BRAZIL_TIME_ZONE_NAMES = Object.freeze({
  'America/Sao_Paulo': BR,
  'America/Bahia': BR,
  'America/Fortaleza': BR,
  'America/Recife': BR,
  'America/Maceio': BR,
  'America/Belem': BR,
  'America/Araguaina': BR,
  'America/Santarem': BR,
  'America/Manaus': 'Horário de Manaus',
  'America/Boa_Vista': 'Horário de Boa Vista',
  'America/Porto_Velho': 'Horário de Porto Velho',
  'America/Cuiaba': 'Horário de Cuiabá',
  'America/Campo_Grande': 'Horário de Campo Grande',
  'America/Rio_Branco': 'Horário do Acre',
  'America/Eirunepe': 'Horário de Eirunepé',
  'America/Noronha': 'Horário de Fernando de Noronha',
});

/** Texto para entrada que não parece IANA. */
export const UNKNOWN_TIME_ZONE_TEXT = 'fuso do estabelecimento';

const PREFIX = 'Horários no fuso do estabelecimento';
const IANA_RE = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){0,2}$/;

/** 1 a 64 caracteres, conferido antes do regex. */
const iana = (tz) => typeof tz === 'string' && tz.length > 0 && tz.length <= 64 && IANA_RE.test(tz);
const nameOf = (tz) => (Object.hasOwn(BRAZIL_TIME_ZONE_NAMES, tz) ? BRAZIL_TIME_ZONE_NAMES[tz] : '');

/** 'Horário de Brasília (America/Sao_Paulo)'; fora da tabela, o IANA; inválido, o genérico. */
export function timeZoneLabel(tz) {
  if (!iana(tz)) return UNKNOWN_TIME_ZONE_TEXT;
  const name = nameOf(tz);
  return name ? `${name} (${tz})` : tz;
}

/** 'Horários no fuso do estabelecimento: <rótulo>.'; inválido: 'Horários no fuso do estabelecimento.' */
export function timeZoneNotice(tz) {
  return iana(tz) ? `${PREFIX}: ${timeZoneLabel(tz)}.` : `${PREFIX}.`;
}

/** ('10:00', 'America/Sao_Paulo') -> '10:00 (Horário de Brasília, America/Sao_Paulo)'. */
export function withTimeZone(text, tz) {
  const name = iana(tz) ? nameOf(tz) : '';
  const inner = !iana(tz) ? UNKNOWN_TIME_ZONE_TEXT : name ? `${name}, ${tz}` : tz;
  const base = typeof text === 'string' ? text : '';
  return base ? `${base} (${inner})` : `(${inner})`;
}
