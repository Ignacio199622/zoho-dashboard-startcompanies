/*
 * El vigia SEMANAL: el informe de mejoras de los lunes, por DM a Pablo Gijon
 * (9:00) y a Ignacio Campo (10:00). Ver lib/vigia/README.md.
 *
 * CERO llamadas a Zoho: se arma con las corridas diarias guardadas en el store
 * `vigia` y la bitacora de Control CRM. Una llamada a Gemini por semana: el
 * texto se arma en el primer envio y el segundo lo reusa (`semanal/<fecha>`),
 * asi los dos leen lo mismo.
 *
 * Cuerpo o query:
 *   hora   12 o 13 (UTC): elige el destinatario. La manda el disparador.
 *   seco   arma el texto y no manda nada (queda en `semanal-seco`).
 *   rehacer  ignora el texto ya armado de esta semana.
 */
import { getStore } from '@netlify/blobs';
import { armarSemanal } from './lib/vigia/semanal.js';
import { DESTINOS, hayToken, mandarDm } from './lib/vigia/dm.js';
import { avisarFalla } from './lib/aviso-falla.js';

const CANDADO_MIN = 20;
const MAX_BITACORA = 30;

export default async (req) => {
  const ahora = new Date();
  const store = getStore({ name: 'vigia', consistency: 'strong' });
  const url = new URL(req.url);
  let hora = url.searchParams.has('hora') ? Number(url.searchParams.get('hora')) : ahora.getUTCHours();
  let seco = url.searchParams.get('seco') === '1';
  let rehacer = url.searchParams.get('rehacer') === '1';
  try {
    const c = await req.json();
    hora = c.hora ?? hora;
    seco = c.seco ?? seco;
    rehacer = c.rehacer ?? rehacer;
  } catch { /* sin cuerpo */ }

  const destino = DESTINOS[hora];
  const semana = ahora.toISOString().slice(0, 10);
  const claveLock = `lock-semanal-${hora}`;

  if (!seco) {
    const candado = await store.get(claveLock).catch(() => null);
    if (candado && ahora - new Date(candado) < CANDADO_MIN * 60e3) {
      console.log(`vigia semanal: ya hay uno corriendo desde ${candado}, no se duplica`);
      return new Response('duplicado');
    }
    await store.set(claveLock, ahora.toISOString());
  }

  try {
    // El texto de esta semana, armado una sola vez.
    let armado = rehacer ? null : await store.get(`semanal/${semana}`, { type: 'json' }).catch(() => null);
    if (!armado) {
      const { blobs } = await store.list({ prefix: 'corrida/' });
      const corridas = [];
      for (const b of blobs) {
        const c = await store.get(b.key, { type: 'json' }).catch(() => null);
        if (c) corridas.push(c);
      }
      corridas.sort((a, b) => (a.id < b.id ? 1 : -1));
      const bitacoraCrm = await getStore({ name: 'control-crm', consistency: 'strong' }).get('bitacora', { type: 'json' });
      armado = { fecha: ahora.toISOString(), ...(await armarSemanal({ corridas, bitacoraCrm, ahora })) };
      if (!seco) await store.setJSON(`semanal/${semana}`, armado);
    }

    let detalle;
    let enviado = false;
    if (seco) detalle = 'seco: no se envio';
    else if (!destino) detalle = `hora ${hora} UTC sin destinatario`;
    else if (!hayToken()) detalle = 'MODO SOMBRA: falta SLACK_BOT_TOKEN';
    else {
      await mandarDm(destino.slack, armado.texto);
      enviado = true;
      detalle = `DM a ${destino.nombre}`;
    }

    if (seco) await store.setJSON('semanal-seco', { fecha: ahora.toISOString(), texto: armado.texto });
    else {
      const previa = (await store.get('bitacora-semanal', { type: 'json' }).catch(() => null)) || [];
      await store.setJSON('bitacora-semanal', [{ id: ahora.toISOString(), hora, para: destino?.nombre || null, enviado, detalle, ...armado.resumen }, ...previa].slice(0, MAX_BITACORA));
      await store.delete(claveLock).catch(() => {});
    }
    console.log(`vigia semanal: ${detalle}\n${armado.texto}`);
    return new Response('ok');
  } catch (e) {
    if (!seco) await store.delete(claveLock).catch(() => {});
    await avisarFalla('El vigía semanal (DM de los lunes)', e, `No salió el semanal para ${destino?.nombre || `la hora ${hora} UTC`}.`);
    return new Response('fallo, avisado');
  }
};
