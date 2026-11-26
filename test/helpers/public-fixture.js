// Dados de referência da página pública (AF-09, critérios 9 e 12): 20 serviços e 10 profissionais.
// Monta tudo pelas rotas autenticadas, como um dono faria.
import { signupAndLogin, createBusinessFor, createService, createProfessional, putHours, WEEK_9_TO_18 } from './session.js';
import { noisePng, realisticJpeg } from './images.js';
import { processLogo } from '../../src/modules/businesses/logo-image.js';
import { DURATION_OPTIONS } from '../../src/shared/services.js';

let seq = 0;

function putImage(app, cookies, url, body, contentType) {
  return app.inject({ method: 'PUT', url, cookies, headers: { 'content-type': contentType }, payload: body });
}

async function expectOk(promise, what) {
  const res = await promise;
  if (res.statusCode !== 200) throw new Error(`${what} falhou: ${res.statusCode} ${res.body}`);
  return res;
}

/**
 * @param {import('fastify').FastifyInstance} app
 * @param {{
 *   services?: number, professionals?: number, logo?: 'realistic'|'worst'|null, photos?: boolean,
 *   hours?: boolean, email?: string, slug?: string,
 *   names?: { business?: string, address?: string, service?: string, professional?: string },
 * }} [options] `names.service`/`names.professional` substituem o nome do 1º serviço/profissional
 * @returns {Promise<{ slug: string, cookies: object, business: object, services: object[], professionals: object[] }>}
 */
export async function seedPublicBusiness(
  app,
  { services = 20, professionals = 10, logo = 'realistic', photos = true, hours = true, email, slug, names = {} } = {},
) {
  seq += 1;
  const cookies = await signupAndLogin(app, { email: email || `dono${seq}-${Date.now()}@x.com` });
  const businessInput = { name: names.business || `Salão Referência ${seq}` };
  if (names.address) businessInput.address = names.address;
  if (slug) businessInput.slug = slug;
  let business = await createBusinessFor(app, cookies, businessInput);

  if (logo) {
    const body = logo === 'worst' ? await processLogo(await noisePng(1024, 1024)) : await realisticJpeg(800, 800);
    const res = await expectOk(
      putImage(app, cookies, '/api/business/logo', body, logo === 'worst' ? 'image/png' : 'image/jpeg'),
      'upload do logo',
    );
    business = res.json().business;
  }

  const createdServices = [];
  for (let i = 0; i < services; i++) {
    const onRequest = i % 4 === 3;
    const body = {
      name: i === 0 && names.service ? names.service : `Serviço ${String(i + 1).padStart(2, '0')}`,
      durationMinutes: DURATION_OPTIONS[(i * 5) % DURATION_OPTIONS.length],
    };
    if (onRequest) {
      body.priceOnRequest = true;
      body.price = null;
    } else body.price = i % 2 === 0 ? `${30 + i * 7},50` : `${1000 + i * 113}`;
    createdServices.push(await createService(app, cookies, body));
  }

  const createdProfessionals = [];
  for (let i = 0; i < professionals; i++) {
    // Cobre todos os serviços (2 por profissional) e acrescenta de 0 a 2 extras: 2 a 4 serviços.
    const ids = new Set();
    if (createdServices.length > 0) {
      for (let k = 0; k < 2 + (i % 3); k++) ids.add(createdServices[(i * 2 + k) % createdServices.length].id);
    }
    const name = i === 0 && names.professional ? names.professional : `Profissional ${String(i + 1).padStart(2, '0')}`;
    let professional = await createProfessional(app, cookies, { name, serviceIds: [...ids] });
    if (photos) {
      const photo = await realisticJpeg(600, 800, { hue: (i * 37) % 360 });
      const res = await expectOk(
        putImage(app, cookies, `/api/professionals/${professional.id}/photo`, photo, 'image/jpeg'),
        'upload da foto',
      );
      professional = res.json().professional;
    }
    if (hours) await expectOk(putHours(app, cookies, professional.id, WEEK_9_TO_18), 'grade de horários');
    createdProfessionals.push(professional);
  }

  return { slug: business.slug, cookies, business, services: createdServices, professionals: createdProfessionals };
}
