// Prueba el candado de socio y las fuentes extra de la apertura de Daniel.
// Sin red, sin Zoho, sin WhatsApp: solo las decisiones. `node scripts/test-daniel-candados.mjs`
import assert from 'node:assert/strict';
import { candadoSocio, fuenteExtra, fuentesExtraActivas, FUENTES_EXTRA } from '../netlify/functions/lib/matias-candados.js';

let ok = 0;
const caso = (nombre, fn) => { fn(); ok++; console.log(`✓ ${nombre}`); };
const tags = (...n) => n.map((name) => ({ name }));

// ─── Candado de socio ───────────────────────────────────────────────────────
caso('lead normal de formulario: se le escribe', () => assert.equal(candadoSocio({ Lead_Source: 'Meta Ads', Tag: tags('Form Nov Meta') }), ''));
caso('Bloqueo_de_envio tildado: frena', () => assert.match(candadoSocio({ Bloqueo_de_envio: true }), /Bloqueo/));
caso('LLC con Socio cargado (lookup): frena', () => assert.match(candadoSocio({ Socio: { name: 'Tax Solutions LATAM', id: '1' } }), /Tax Solutions/));
caso('trato con Partner de un socio: frena', () => assert.match(candadoSocio({ Partner: 'Globo' }), /Globo/));
caso('trato con Partner "Start Companies": no frena', () => assert.equal(candadoSocio({ Partner: 'Start Companies' }), ''));
caso('trato con Partner "Partner" (genérico): no frena', () => assert.equal(candadoSocio({ Partner: 'Partner' }), ''));
caso('contacto que es partner: frena', () => assert.match(candadoSocio({ Tipo_de_Contacto: 'Partner' }), /partner/));
caso('Tipo "Posible Partner" (quiere ser socio): NO frena', () => assert.equal(candadoSocio({ Tipo: 'Posible Partner', Tag: tags('Form Socios Meta', 'Tipo - Posible Partner') }), ''));
caso('Tipo "Partner" (cliente de partner): frena', () => assert.match(candadoSocio({ Tipo: 'Cliente Partner' }), /Tipo/));
caso('fuente Partner: frena', () => assert.match(candadoSocio({ Lead_Source: 'Partner' }), /fuente Partner/));
caso('fuente Partner pero Posible Partner: no frena', () => assert.equal(candadoSocio({ Lead_Source: 'Partner', Tipo: 'Posible Partner' }), ''));
caso('etiqueta "Socio Tax Solutions": frena', () => assert.match(candadoSocio({ Tag: tags('Socio Tax Solutions') }), /etiqueta/));
caso('etiqueta "Partner: Globo": frena', () => assert.match(candadoSocio({ Tag: tags('Partner: Globo') }), /etiqueta/));
caso('etiqueta "Form Socios Meta" sola: no frena', () => assert.equal(candadoSocio({ Tag: tags('Form Socios Meta') }), ''));
caso('Posible Partner con Bloqueo tildado: frena igual', () => assert.match(candadoSocio({ Tipo: 'Posible Partner', Bloqueo_de_envio: true }), /Bloqueo/));

// ─── Interruptor de fuentes ─────────────────────────────────────────────────
caso('apagado por defecto', () => assert.deepEqual(fuentesExtraActivas({}), []));
caso('apagado con la lista cargada', () => assert.deepEqual(fuentesExtraActivas({ MATIAS_FUENTES_EXTRA: 'web,youtube' }), []));
caso('prendido sin lista: todas', () => assert.deepEqual(fuentesExtraActivas({ MATIAS_FUENTES_EXTRA_ENABLED: 'true' }), FUENTES_EXTRA));
caso('prendido con lista: solo esas (y descarta las que no existen)', () => assert.deepEqual(fuentesExtraActivas({ MATIAS_FUENTES_EXTRA_ENABLED: '1', MATIAS_FUENTES_EXTRA: 'youtube, wa,inventada' }), ['youtube', 'wa']));

// ─── Fuentes ────────────────────────────────────────────────────────────────
const todas = FUENTES_EXTRA;
const tel = '+5491112345678';
caso('apagado: ninguna fuente', () => assert.equal(fuenteExtra({ Lead_Source: 'Referido', Mobile: tel }, []), ''));
caso('web: SEO / Web Orgánica', () => assert.equal(fuenteExtra({ Lead_Source: 'SEO / Web Orgánica' }, todas), 'web'));
caso('web: Web Organic', () => assert.equal(fuenteExtra({ Lead_Source: 'Web Organic' }, todas), 'web'));
caso('landing: Landing Page reporta web', () => assert.equal(fuenteExtra({ Lead_Source: 'Landing Page' }, todas), 'web'));
caso('landing: slug de página reporta web', () => assert.equal(fuenteExtra({ Landing_Origen: 'llc-7-dias' }, todas), 'web'));
caso('landing de Lili: no', () => assert.equal(fuenteExtra({ Landing_Origen: 'lili-plataforma' }, todas), ''));
caso('landing de partners: no', () => assert.equal(fuenteExtra({ Landing_Origen: 'partners-sc' }, todas), ''));
caso('youtube por etiqueta', () => assert.equal(fuenteExtra({ Tag: tags('LLC Apertura - YouTube') }, todas), 'youtube'));
caso('youtube por fuente', () => assert.equal(fuenteExtra({ Lead_Source: 'YouTube Orgánico' }, todas), 'youtube'));
caso('wa: sin origen de fuente con teléfono', () => assert.equal(fuenteExtra({ Lead_Source: 'Sin origen de fuente', Mobile: tel }, todas), 'wa'));
caso('wa: sin teléfono no', () => assert.equal(fuenteExtra({ Lead_Source: 'Sin origen de fuente' }, todas), ''));
caso('wa: el que le escribió a Daniel no', () => assert.equal(fuenteExtra({ Lead_Source: 'Sin origen de fuente', Mobile: tel, Landing_Origen: 'SDR MATIAS - WP directo', Tag: tags('WhatsApp Matias') }, todas), ''));
caso('marca personal', () => assert.equal(fuenteExtra({ Lead_Source: 'Marca Personal' }, todas), 'marca'));
caso('marca: DM de @ignacio.llc', () => assert.equal(fuenteExtra({ Landing_Origen: 'ig-dm-ignacio' }, todas), 'marca'));
caso('referido', () => assert.equal(fuenteExtra({ Lead_Source: 'Referido' }, todas), 'referido'));
caso('chatbot Starti', () => assert.equal(fuenteExtra({ Lead_Source: 'Chatbot Starti' }, todas), 'chatbot'));
caso('Meta Ads no es fuente extra', () => assert.equal(fuenteExtra({ Lead_Source: 'Meta Ads', Landing_Origen: 'Form Nov Meta' }, todas), ''));
caso('Google Ads no es fuente extra', () => assert.equal(fuenteExtra({ Lead_Source: 'Google Ads' }, todas), ''));
caso('lista parcial: youtube prendido, referido no', () => {
  assert.equal(fuenteExtra({ Lead_Source: 'Referido' }, ['youtube']), '');
  assert.equal(fuenteExtra({ Lead_Source: 'YouTube Ads' }, ['youtube']), 'youtube');
});

console.log(`\n${ok} casos OK`);
