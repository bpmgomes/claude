/**
 * Relógio controlável para testes.
 * @param {string} [startIso]
 * @returns {{ now: () => Date, advance: (ms: number) => void }}
 */
export function createClock(startIso = '2026-01-01T12:00:00.000Z') {
  let current = Date.parse(startIso);
  return {
    now: () => new Date(current),
    advance(ms) {
      current += ms;
    },
  };
}
