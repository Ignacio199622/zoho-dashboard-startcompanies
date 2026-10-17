/*
 * El vigia: un informe a Slack a las 9 y a las 18 (Argentina) con errores de
 * usuarios, quejas y dudas repetidas, mejoras sugeridas y CRM trabado.
 * Ver lib/vigia/README.md.
 *
 * SOLO LECTURA: no escribe en Zoho ni le manda nada a nadie salvo el informe
 * por DM a Ignacio (VIGIA_DIARIO_A, default U0869LQ3G4C). Por corrida: 1 llamada a Zoho (messages__s con If-Modified-Since,
 * con el token compartido del store `zoho-token`), 1 a Gemini, y la bitacora
 * de Control CRM leida del store `control-crm`.
 *
 * Envio: chat.postMessage con el bot token (SLACK_BOT_TOKEN_VIGIA o
 * SLACK_BOT_TOKEN) y channel=<ID de usuario>. Si ademas esta cargado
 * SLACK_WEBHOOK_VIGIA, sale tambien a ese canal. Sin token ni webhook corre en
 * MODO SOMBRA: arma el informe, lo guarda en el store `vigia` (clave
 * `ultimo-informe`) y no lo manda.
 *
 * `?seco=1` (o {"seco":true}) arma el informe sin mandarlo y sin mover la
 * marca de "hasta donde se leyo".
 *
 * Cada corrida real guarda su foto en `corrida/<ISO>` (21 dias): de ahi sale
 * el semanal de los lunes (vigia-semanal-background.mjs) sin volver a Zoho.
 */
import { getStore } from '@netlify/blobs';
import { get as zohoGet } from './lib/conversaciones/zoho.js';
import { juntar, texto, fotoDelDia } from './lib/vigia/informe.js';
import { diarioA, hayToken, mandarDm } from './lib/vigia/dm.js';
import { avisarFalla } from './lib/aviso-falla.js';

const CANDADO_MIN = 20;
const MAX_BITACORA = 60;
// La ventana normal es "desde el informe anterior". Si el anterior no salio,
// no se mira mas de un dia para atras: el informe no es un backlog.
const VENTANA_POR_DEFECTO_H = 12;
const VENTANA_MAX_H = 24;
// Las corridas guardadas para el semanal. Tres semanas alcanzan y sobran.
const DIAS_CORRIDAS = 21;

export default async (req) => {
  const ahora = new Date();
  const store = getStore({ name: 'vigia', consistency: 'strong' });

  const url = new URL(req.url);
  let seco = url.searchParams.get('seco') === '1';
  try {
    const cuerpo = await req.json();
    seco = cuerpo.seco ?? seco;
  } catch { /* sin cuerpo */ }

  // Candado: si Netlify reintenta el cron, sale un solo informe.
  if (!seco) {
    const candado = await store.get('lock').catch(() => null);
    if (candado && ahora - new Date(candado) < CANDADO_MIN * 60e3) {
      console.log(`vigia: ya hay uno corriendo desde ${candado}, no se duplica`);
      return new Response('duplicado');
    }
    await store.set('lock', ahora.toISOString());
  }

  try {
    const marca = await store.get('ultima-corrida', { type: 'json' }).catch(() => null);
    const piso = new Date(ahora - VENTANA_MAX_H * 36e5);
    let desde = marca?.hasta ? new Date(marca.hasta) : new Date(ahora - VENTANA_POR_DEFECTO_H * 36e5);
    if (desde < piso) desde = piso;

    const bitacoraCrm = await getStore({ name: 'control-crm', consistency: 'strong' }).get('bitacora', { type: 'json' });

    const r = await juntar({ ahora, desde, get: zohoGet, bitacoraCrm, crmInformado: marca?.crmInformado });
    const mensaje = texto(r);

    // Va por DM a Ignacio (VIGIA_DIARIO_A) con el bot token. Si ademas hay
    // SLACK_WEBHOOK_VIGIA cargado, sale tambien a ese canal.
    const webhook = process.env.SLACK_WEBHOOK_VIGIA;
    let enviado = false;
    let detalle = null;
    if (seco) detalle = 'seco: no se envio';
    else if (!hayToken() && !webhook) detalle = 'MODO SOMBRA: falta SLACK_BOT_TOKEN (o SLACK_WEBHOOK_VIGIA)';
    else {
      const hechos = [];
      if (hayToken()) {
        await mandarDm(diarioA(), mensaje);
        hechos.push(`DM a ${diarioA()}`);
      }
      if (webhook) {
        const s = await fetch(webhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: mensaje }),
        });
        if (!s.ok) throw new Error(`Slack respondio ${s.status}: ${(await s.text()).slice(0, 200)}`);
        hechos.push('webhook');
      }
      enviado = true;
      detalle = hechos.join(' + ');
    }

    await store.setJSON(seco ? 'ultimo-informe-seco' : 'ultimo-informe', { fecha: ahora.toISOString(), texto: mensaje });
    if (!seco) {
      // La foto del dia, para que el semanal no tenga que volver a Zoho.
      await store.setJSON(`corrida/${ahora.toISOString()}`, fotoDelDia(r));
      try {
        const { blobs } = await store.list({ prefix: 'corrida/' });
        const piso = new Date(ahora - DIAS_CORRIDAS * 864e5).toISOString();
        for (const b of blobs) if (b.key.slice('corrida/'.length) < piso) await store.delete(b.key);
      } catch (e) { console.log('vigia: no se pudieron podar corridas viejas -', e.message); }
      await store.setJSON('ultima-corrida', { hasta: ahora.toISOString(), crmInformado: r.crm?.cierreId || marca?.crmInformado || null });
      const previa = (await store.get('bitacora', { type: 'json' }).catch(() => null)) || [];
      await store.setJSON('bitacora', [{
        id: ahora.toISOString(),
        agente: 'vigia',
        desde: desde.toISOString(),
        segundos: Math.round((Date.now() - ahora) / 1000),
        whatsappLeidas: r.wa?.leidas ?? null,
        esperando: r.wa?.pendientes?.length ?? null,
        problemas: r.wa?.problemas?.length ?? null,
        mejoras: r.wa?.mejoras?.length ?? null,
        errores: r.errores,
        enviado,
        detalle,
        estado: 'ok',
      }, ...previa].slice(0, MAX_BITACORA));
      await store.delete('lock').catch(() => {});
    }

    console.log(`vigia: ${enviado ? 'enviado' : detalle}\n${mensaje}`);
    return new Response('ok');
  } catch (e) {
    if (!seco) await store.delete('lock').catch(() => {});
    await avisarFalla('El vigía (informe de las 9 y las 18)', e, 'No salió el informe. Mirá el log de vigia-background en Netlify.');
    return new Response('fallo, avisado');
  }
};
