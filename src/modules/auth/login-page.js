// HTML do /login (AF-03, design 4.1, decisão 7 do Gerente): o link "Esqueci minha senha" só aparece
// com transporte de e-mail ativo. Renderizado UMA vez no boot a partir de web/login.html. Puro.

/** Marcador de web/login.html trocado no boot. */
export const FORGOT_PASSWORD_MARKER = '<!--forgot-password-->';

/** Bloco do link (constante; nenhum dado do usuário). */
export const FORGOT_PASSWORD_BLOCK =
  '<p class="secondary-link" id="forgot-password"><a href="/esqueci-senha">Esqueci minha senha</a></p>';

/**
 * @param {string} template conteúdo de web/login.html
 * @param {{ forgotPasswordEnabled: boolean }} options
 * @returns {string} o HTML com o bloco no lugar do marcador, ou sem o marcador
 * @throws {Error} template sem exatamente um marcador
 */
export function renderLoginPage(template, { forgotPasswordEnabled }) {
  const text = String(template);
  const parts = text.split(FORGOT_PASSWORD_MARKER);
  if (parts.length !== 2) throw new Error('renderLoginPage: marcador ausente ou repetido.');
  return parts.join(forgotPasswordEnabled ? FORGOT_PASSWORD_BLOCK : '');
}
