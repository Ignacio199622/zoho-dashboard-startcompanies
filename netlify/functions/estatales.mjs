/*
 * Aviso de renovaciones ESTATALES (Annual Report) a Nacho Campo y Pablo.
 *
 * Pedido de Ignacio (29-oct-2026, despues del reclamo de GloboBanks por
 * BYHUMANS TECH y AMURA): un mes antes de cada vencimiento estatal, avisar; y
 * repetir hasta que lo marquen como presentado. El "bucle" es eso: cada lunes
 * vuelve todo lo que sigue sin marcar.
 *
 *   - El dia 1 de cada mes y todos los lunes, 9 h Argentina.
 *   - Va lo vencido sin confirmar y lo que vence dentro de 35 dias.
 *   - Si hay vencidas, tambien le llega a Ignacio.
 *   - Se corta solo: la marca de la planilla (pestaña Estatales) escribe la
 *     fecha en la LLC y esa LLC deja de aparecer.
 *
 * Toda la regla de fechas esta en lib/estatales.js, sin red.
 * DM por chat.postMessage al ID de usuario, como el Vigia (chat:write alcanza).
 */
import { env } from './lib/entorno.js';
import { paginado, tokenActual } from './lib/control-crm/zoho.js';
import { filasEstatales, armarAviso, fechasParaZoho } from './lib/estatales.js';
import { avisarFalla } from './lib/aviso-falla.js';

const A = (env.ESTATALES_A || 'U08LT8252Q3,U0BTT434078').split(',').map((s) => s.trim()).filter(Boolean); // Nacho Campo, Pablo
const IGNACIO = env.ESTATALES_ESCALAR_A || 'U0869LQ3G4C';
const LINK = 'https://metricastart.netlify.app/planilla.html?tipo=Estatal';
const FIRMA = { username: 'Renovaciones estatales · Start Companies', icon_emoji: ':classical_building:' };

async function postear(channel, text) {
  const r = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
    body: JSON.stringify({ channel, text, unfurl_links: false, ...FIRMA }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`${channel}: ${j.error}`);
}

/**
 * Corrige en Zoho la fecha estatal de cada LLC (ver fechasParaZoho). trigger:[] para no
 * disparar reglas. ESTATALES_CORREGIR_ZOHO=0 lo apaga. Devuelve cuantas cambio.
 */
async function corregirFechasZoho(cambios) {
  if (env.ESTATALES_CORREGIR_ZOHO === '0' || !cambios.length) return 0;
  const tok = await tokenActual();
  let ok = 0;
  for (let i = 0; i < cambios.length; i += 100) {
    const r = await fetch('https://www.zohoapis.com/crm/v6/Accounts', {
      method: 'PUT',
      headers: { Authorization: `Zoho-oauthtoken ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: cambios.slice(i, i + 100), trigger: [] }),
    });
    const j = await r.json().catch(() => ({}));
    ok += (j.data || []).filter((d) => d.code === 'SUCCESS').length;
  }
  return ok;
}

export default async () => {
  const ar = new Date(Date.now() - 3 * 3600e3);
  const toca = ar.getUTCDate() === 1 || ar.getUTCDay() === 1;

  try {
    const [llcs, tratos] = await Promise.all([
      paginado('Accounts', 'id,Account_Name,Estado_de_Registro,Fecha_de_Constituci_n,ltima_renovaci_n_estatal,Fecha_renovaci_n_estatal,Socio,Status'),
      paginado('Deals', 'id,Type,Account_Name,Renovaci_n_estatal,Renovaci_n_federal,Origen_del_trato,Created_Time'),
    ]);
    const filas = filasEstatales(llcs, tratos);
    // Todos los dias: la fecha estatal de Zoho (la que muestra el panel) queda igual a la real.
    const corregidas = await corregirFechasZoho(fechasParaZoho(filas, llcs));
    if (!toca) return new Response(`hoy no toca el aviso; fechas corregidas en Zoho: ${corregidas}`);
    const aviso = armarAviso(filas, LINK);
    if (!aviso) return new Response('nada pendiente');

    const destinos = aviso.vencidas ? [...A, IGNACIO] : A;
    for (const u of destinos) for (const m of aviso.mensajes) await postear(u, m);
    return new Response(`enviado a ${destinos.length}: ${aviso.vencidas} vencidas, ${aviso.proximas} proximas`);
  } catch (e) {
    await avisarFalla('Aviso de renovaciones estatales', e, 'Mirar lib/estatales.js y el token de Zoho');
    return new Response('fallo', { status: 500 });
  }
};

export const config = { schedule: '0 12 * * *' };
