import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectImageType,
  processLogo,
  LOGO_SIZE,
  DIMENSIONS_MESSAGE,
} from '../../src/modules/businesses/logo-image.js';
import { InvalidImageError } from '../../src/http/errors.js';
import {
  pngOf,
  jpegOf,
  jpegWithExif,
  gifOf,
  webpOf,
  svgBytes,
  truncated,
  pngWithBadCrc,
  pngHeaderOnly,
  metadataOf,
} from '../helpers/images.js';

const GENERIC = 'Envie uma imagem PNG ou JPG válida.';

describe('detectImageType (critério 10)', () => {
  test('PNG e JPEG pela assinatura', async () => {
    assert.equal(detectImageType(await pngOf(4, 4)), 'png');
    assert.equal(detectImageType(await jpegOf(4, 4)), 'jpeg');
  });

  test('GIF, SVG, WebP, HTML e vazio dão null', async () => {
    assert.equal(detectImageType(await gifOf()), null);
    assert.equal(detectImageType(svgBytes()), null);
    assert.equal(detectImageType(await webpOf()), null);
    assert.equal(detectImageType(Buffer.from('<!doctype html><script>x</script>')), null);
    assert.equal(detectImageType(Buffer.alloc(0)), null);
    assert.equal(detectImageType(undefined), null);
  });

  test('GIF "renomeado" para .png continua GIF (o nome nem chega ao servidor)', async () => {
    const gif = await gifOf();
    const file = { name: 'logo.png', type: 'image/png', bytes: gif };
    assert.equal(detectImageType(file.bytes), null);
  });
});

describe('processLogo (critérios 12, 13, 14)', () => {
  test('PNG 800×400 vira PNG 256×256', async () => {
    const out = await processLogo(await pngOf(800, 400));
    const meta = await metadataOf(out);
    assert.equal(meta.format, 'png');
    assert.equal(meta.width, LOGO_SIZE);
    assert.equal(meta.height, LOGO_SIZE);
  });

  test('JPEG 300×900 vira PNG 256×256', async () => {
    const meta = await metadataOf(await processLogo(await jpegOf(300, 900)));
    assert.deepEqual([meta.format, meta.width, meta.height], ['png', 256, 256]);
  });

  test('JPEG com EXIF: saída sem exif, icc e xmp', async () => {
    const input = await jpegWithExif(300, 300);
    assert.ok((await metadataOf(input)).exif, 'a entrada precisa ter EXIF');
    const out = await processLogo(input);
    const meta = await metadataOf(out);
    assert.equal(meta.exif, undefined);
    assert.equal(meta.icc, undefined);
    assert.equal(meta.xmp, undefined);
    assert.equal(out.includes(Buffer.from('segredo')), false);
  });

  test('JPEG truncado -> InvalidImageError', async () => {
    await assert.rejects(processLogo(truncated(await jpegOf(300, 300))), (err) => {
      assert.ok(err instanceof InvalidImageError);
      assert.equal(err.statusCode, 422);
      assert.equal(err.message, GENERIC);
      return true;
    });
  });

  test('PNG com CRC corrompido -> InvalidImageError', async () => {
    await assert.rejects(processLogo(pngWithBadCrc(await pngOf(10, 10))), InvalidImageError);
  });

  test('bomb 20000×20000 -> InvalidImageError com mensagem de dimensões, em menos de 1 s', async () => {
    const start = Date.now();
    await assert.rejects(processLogo(pngHeaderOnly(20000, 20000)), (err) => {
      assert.ok(err instanceof InvalidImageError);
      assert.equal(err.message, DIMENSIONS_MESSAGE);
      return true;
    });
    assert.ok(Date.now() - start < 1000);
  });

  test('largura acima de 4096 (mesmo com poucos pixels) -> mensagem de dimensões', async () => {
    await assert.rejects(processLogo(pngHeaderOnly(5000, 10)), { message: DIMENSIONS_MESSAGE });
  });

  test('GIF, SVG e vazio -> InvalidImageError', async () => {
    for (const input of [await gifOf(), svgBytes(), Buffer.alloc(0)]) {
      await assert.rejects(processLogo(input), InvalidImageError);
    }
  });

  test('assinatura PNG com conteúdo GIF -> InvalidImageError (formato precisa bater)', async () => {
    const gif = await gifOf();
    const fake = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), gif]);
    await assert.rejects(processLogo(fake), InvalidImageError);
  });
});
