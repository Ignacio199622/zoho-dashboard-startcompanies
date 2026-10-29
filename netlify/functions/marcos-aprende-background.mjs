// La pasada semanal de "Marcos aprende" (ver lib/marcos-aprende.js).
//
// Para probar sin mandar nada: POST ...?enviar=0  (hace todo, no manda DMs y
// no marca los huecos como propuestos). Con ?dias=14 mira dos semanas.
import { getStore } from '@netlify/blobs';
import { correr, mandarTanda } from './lib/marcos-aprende.js';
import { avisarFalla } from './lib/aviso-falla.js';

const CANDADO_MIN = 30;

export default async (req) => {
  const ahora = new Date();
  const url = new URL(req.url);
  const enviar = url.searchParams.get('enviar') !== '0' && process.env.MARCOS_APRENDE_ENVIAR !== '0';
  const dias = Number(url.searchParams.get('dias')) || undefined;

  const store = getStore({ name: 'autorespuesta', consistency: 'strong' });

  // Una tanda escrita a mano (lib/marcos-aprende-tanda1.js). Cada una sale una sola vez.
  const tanda = url.searchParams.get('tanda');
  if (tanda) {
    try {
      const r = await mandarTanda(tanda, { ahora });
      console.log(`tanda ${tanda}:`, JSON.stringify(r));
      await store.setJSON('aprende-ultima', { cuando: ahora.toISOString(), tanda, ...r }).catch(() => {});
      return new Response(JSON.stringify(r), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (e) {
      await avisarFalla(`Marcos aprende (tanda ${tanda})`, e, 'No salieron los DMs de la tanda.');
      return new Response(`fallo, avisado: ${e.message}`, { status: 200 });
    }
  }

  // Candado: si el cron se dispara dos veces (reintento de Netlify), sale un solo DM.
  const candado = await store.get('lock-aprende').catch(() => null);
  if (enviar && candado && ahora - new Date(candado) < CANDADO_MIN * 60e3) {
    console.log(`marcos aprende: ya hay una pasada desde ${candado}, no se duplica`);
    return new Response('duplicado', { status: 200 });
  }
  if (enviar) await store.set('lock-aprende', ahora.toISOString());
  try {
    const r = await correr({ ahora, enviar, dias });
    console.log(`marcos aprende: ${r.mensajes} mensajes, ${r.clientes} clientes, ${r.huecos.length} huecos${r.motivo ? ` (${r.motivo})` : ''}`);
    for (const h of r.huecos) console.log(`  - ${h.titulo_guia} (${h.numeros.length} clientes${h.necesita_video ? ', video' : ''})`);
    if (r.dms) console.log('dms:', JSON.stringify(r.dms));
    // La background contesta 202 antes de terminar: el resultado se lee del blob.
    await store.setJSON('aprende-ultima', { cuando: ahora.toISOString(), enviar, ...r }).catch(() => {});
    return new Response(JSON.stringify(r), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    if (enviar) await store.delete('lock-aprende').catch(() => {});
    await avisarFalla('Marcos aprende (las guías que faltan)', e, 'No salió el DM semanal con las guías y videos que faltan en el panel.');
    return new Response(`fallo, avisado: ${e.message}`, { status: 200 });
  }
};
