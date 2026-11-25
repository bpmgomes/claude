// Invólucro do pipeline compartilhado (src/images/square-image.js, design AF-07 4.1).
// O comportamento do logo não muda: test/unit/logo-image.test.js continua valendo.
import { processSquareImage, IMAGE_SIZE } from '../../images/square-image.js';

export { detectImageType, MAX_DIMENSION, MAX_INPUT_PIXELS, DIMENSIONS_MESSAGE } from '../../images/square-image.js';

export const LOGO_SIZE = IMAGE_SIZE;

/**
 * Logo: PNG 256×256, sem metadados.
 * @param {Buffer} buffer
 * @returns {Promise<Buffer>}
 * @throws {import('../../http/errors.js').InvalidImageError}
 */
export const processLogo = (buffer) => processSquareImage(buffer);
