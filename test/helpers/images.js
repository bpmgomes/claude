// Imagens geradas na hora com o próprio sharp (sem fixtures binárias no repositório).
import sharp from 'sharp';
import { crc32, deflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function background() {
  return { r: 200, g: 30, b: 90, alpha: 1 };
}

/** PNG w×h válido. */
export function pngOf(w, h) {
  return sharp({ create: { width: w, height: h, channels: 4, background: background() } }).png().toBuffer();
}

/** JPEG w×h sem metadados. */
export function jpegOf(w, h) {
  return sharp({ create: { width: w, height: h, channels: 3, background: background() } }).jpeg().toBuffer();
}

/** JPEG w×h com EXIF (Copyright e Artist). */
export function jpegWithExif(w, h) {
  return sharp({ create: { width: w, height: h, channels: 3, background: background() } })
    .jpeg()
    .withExif({ IFD0: { Copyright: 'segredo', Artist: 'Ana' } })
    .toBuffer();
}

/** GIF válido. */
export function gifOf(w = 16, h = 16) {
  return sharp({ create: { width: w, height: h, channels: 3, background: background() } }).gif().toBuffer();
}

/** WebP válido. */
export function webpOf(w = 16, h = 16) {
  return sharp({ create: { width: w, height: h, channels: 3, background: background() } }).webp().toBuffer();
}

/** SVG com script (nunca pode ser aceito nem servido). */
export function svgBytes() {
  return Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>',
  );
}

/** Corta o final do arquivo (imagem truncada). */
export function truncated(buffer, keep = 0.5) {
  return buffer.subarray(0, Math.floor(buffer.length * keep));
}

function chunk(type, data) {
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

/**
 * Insere antes do IEND um chunk ancilar privado `prVt` para o PNG ter exatamente `size` bytes.
 * O resultado continua sendo um PNG válido.
 */
export function padPngTo(buffer, size) {
  const iendAt = buffer.length - 12; // IEND: 4 (length) + 4 (type) + 0 + 4 (crc)
  if (buffer.subarray(iendAt + 4, iendAt + 8).toString('latin1') !== 'IEND') throw new Error('PNG sem IEND no fim');
  const dataLength = size - buffer.length - 12;
  if (dataLength < 0) throw new Error('PNG já é maior que o tamanho pedido');
  const padded = Buffer.concat([buffer.subarray(0, iendAt), chunk('prVt', Buffer.alloc(dataLength)), buffer.subarray(iendAt)]);
  if (padded.length !== size) throw new Error('tamanho inesperado');
  return padded;
}

/** PNG com o CRC do IHDR corrompido. */
export function pngWithBadCrc(buffer) {
  const copy = Buffer.from(buffer);
  // assinatura (8) + length (4) + "IHDR" (4) + 13 bytes de dados -> CRC em 29..32
  copy[29] ^= 0xff;
  return copy;
}

/**
 * PNG que declara width×height no IHDR, com IDAT mínimo: simula uma decompression bomb
 * sem alocar a imagem.
 */
export function pngHeaderOnly(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.alloc(16))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Dimensões e metadados de uma imagem. */
export function metadataOf(buffer) {
  return sharp(buffer).metadata();
}
