// Verificações de acessibilidade medidas no próprio navegador (AF-14, design 6.2): o cálculo de
// luminância e o de alvos de toque são os do public-page.e2e.js (AF-09), copiados aqui para não mexer
// naquele arquivo. Sem dependência nova (decisão 18).
/* global document, getComputedStyle */

/** `a` e `button` visíveis com menos de 44 x 44 px (dentro de `root`, padrão o documento). */
export function smallTargets(page, root = 'body') {
  return page.evaluate((selector) => {
    const scope = document.querySelector(selector) || document.body;
    return [...scope.querySelectorAll('a, button')]
      .map((el) => ({ el, rect: el.getBoundingClientRect() }))
      .filter(({ rect }) => rect.width > 0 && rect.height > 0)
      .filter(({ rect }) => rect.width < 44 || rect.height < 44)
      .map(({ el, rect }) => `${el.tagName}#${el.id}.${el.className} ${rect.width}x${rect.height}`);
  }, root);
}

/**
 * Textos abaixo do AA (4,5:1, ou 3:1 para texto grande) dentro de `root`, e, com `borders`, bordas
 * esquerdas e ícones (`.ag-icon`) abaixo de 3:1 com o fundo (WCAG 1.4.11).
 */
export function contrastFailures(page, { root = 'body', borders = false } = {}) {
  return page.evaluate(
    ({ selector, checkBorders }) => {
      const parse = (c) => {
        const m = String(c).match(/rgba?\(([^)]+)\)/);
        if (!m) return null;
        const [r, g, b, a = 1] = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
        return { r, g, b, a };
      };
      const lum = ({ r, g, b }) => {
        const ch = (v) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
      };
      const background = (el) => {
        for (let node = el; node; node = node.parentElement) {
          const bg = parse(getComputedStyle(node).backgroundColor);
          if (bg && bg.a > 0) return bg;
        }
        return { r: 255, g: 255, b: 255, a: 1 };
      };
      const ratioOf = (fg, bg) => {
        const [l1, l2] = [lum(fg), lum(bg)].sort((x, y) => y - x);
        return (l1 + 0.05) / (l2 + 0.05);
      };
      const out = [];
      const scope = document.querySelector(selector) || document.body;
      for (const el of [scope, ...scope.querySelectorAll('*')]) {
        const box = el.getBoundingClientRect();
        if (box.width === 0 && box.height === 0) continue;
        const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
        const style = getComputedStyle(el);
        if (hasText) {
          const ratio = ratioOf(parse(style.color), background(el));
          const size = Number.parseFloat(style.fontSize);
          const bold = Number(style.fontWeight) >= 700;
          const large = size >= 24 || (bold && size >= 18.66);
          if (ratio < (large ? 3 : 4.5)) out.push(`${el.tagName}#${el.id}.${el.className}: ${ratio.toFixed(2)}`);
        }
        if (checkBorders && el.classList.contains('ag-item')) {
          const parentBg = background(el.parentElement);
          const ratio = ratioOf(parse(style.borderLeftColor), parentBg);
          if (ratio < 3) out.push(`borda ${el.className}: ${ratio.toFixed(2)}`);
        }
        if (checkBorders && el.classList.contains('ag-icon')) {
          const ratio = ratioOf(parse(style.color), background(el));
          if (ratio < 3) out.push(`ícone ${el.parentElement.className}: ${ratio.toFixed(2)}`);
        }
      }
      return out;
    },
    { selector: root, checkBorders: borders },
  );
}
