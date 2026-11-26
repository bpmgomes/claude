import sharp from 'sharp';
import { InvalidImageError } from '../http/errors.js';

/** Lado da imagem quadrada gerada (logo e foto de profissional). */
export const IMAGE_SIZE = 256;
/** Mantido em 4096 (design AF-07, decisão 13 e R3). */
export const MAX_DIMENSION = 4096;
export const MAX_INPUT_PIXELS = MAX_DIMENSION * MAX_DIMENSION;
export const DIMENSIONS_MESSAGE = 'A imagem deve ter no máximo 4096×4096 pixels.';

// Não manter imagens de usuários em cache e limitar threads/memória por imagem.
sharp.cache(false);
sharp.concurrency(1);

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);

const SHARP_OPTIONS = Object.freeze({ failOn: 'error', limitInputPixels: MAX_INPUT_PIXELS });

/**
 * Tipo pela assinatura (magic bytes). Qualquer outra coisa (SVG, GIF, WebP, HTML) -> null.
 * @param {Buffer} buffer
 * @returns {'png'|'jpeg'|null}
 */
export function detectImageType(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  if (buffer.length >= PNG_SIGNATURE.length && buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return 'png';
  }
  if (buffer.length >= JPEG_SIGNATURE.length && buffer.subarray(0, JPEG_SIGNATURE.length).equals(JPEG_SIGNATURE)) {
    return 'jpeg';
  }
  return null;
}

/**
 * Valida e reprocessa uma imagem (logo, foto de profissional): PNG size×size, sem metadados
 * (EXIF, XMP, ICC).
 * - `fit: 'contain'` (padrão, logo): imagem inteira, fundo transparente.
 * - `fit: 'cover'` (foto de profissional, AF-09): corta ao centro, sem faixas.
 * Nunca deixa escapar erro do sharp: tudo vira InvalidImageError, com `reason`
 * (curto, sem conteúdo da imagem) para o log de rejeição da rota.
 * @param {Buffer} buffer
 * @param {{ size?: number, fit?: 'contain'|'cover' }} [options]
 * @returns {Promise<Buffer>}
 * @throws {InvalidImageError}
 */
export async function processSquareImage(buffer, { size = IMAGE_SIZE, fit = 'contain' } = {}) {
  const reject = (reason, message) => {
    const error = new InvalidImageError(message);
    error.reason = reason;
    return error;
  };

  const type = detectImageType(buffer);
  if (fit !== 'contain' && fit !== 'cover') throw new TypeError(`fit inválido: ${fit}`);
  if (!type) throw reject(buffer && buffer.length ? 'signature' : 'empty');

  let meta;
  try {
    // Só lê o cabeçalho.
    meta = await sharp(buffer, SHARP_OPTIONS).metadata();
  } catch (err) {
    throw sharpFailure(err);
  }
  if (meta.format !== type) throw reject('format_mismatch');
  if (!meta.width || !meta.height) throw reject('dimensions');
  if (meta.width > MAX_DIMENSION || meta.height > MAX_DIMENSION) {
    throw reject('too_large_dimensions', DIMENSIONS_MESSAGE);
  }

  try {
    return await sharp(buffer, SHARP_OPTIONS)
      .rotate()
      .resize(
        size,
        size,
        fit === 'cover'
          ? { fit: 'cover', position: 'centre' }
          : { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } },
      )
      .png({ compressionLevel: 9 })
      .toBuffer();
  } catch (err) {
    throw sharpFailure(err);
  }

  // O sharp recusa pelo `limitInputPixels` antes de decodificar ("exceeds pixel limit").
  function sharpFailure(err) {
    return /pixel limit/i.test(String(err && err.message))
      ? reject('too_large_dimensions', DIMENSIONS_MESSAGE)
      : reject('decode');
  }
}
