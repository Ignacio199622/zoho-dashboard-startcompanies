// La pasada de apertura de Matias (ver lib/matias-apertura.js). Corre en
// background por el techo de 10 s de las funciones normales: cada lead son 2 o
// 3 llamadas a Zoho y una a Meta.
import { getStore } from '@netlify/blobs';
import { pasada, previaBarrido, prenderBarrido, apagarBarrido, estadoBarrido } from './lib/matias-apertura.js';
import { avisarFalla } from './lib/aviso-falla.js';
import { enCanal } from './lib/matias.js';

/*
 * El barrido (ver lib/matias-apertura.js) se maneja por POST con x-clave =
 * CALCOM_SECRET y un JSON:
 *   { "previa": true, "desde": "2026-09-01T00:00:00-03:00" }  cuenta sin mandar,
 *       deja el detalle en el blob `backfill-previa` y resume en #sdr-virtual-matias
 *   { "prender": true, "desde": "...", "tope": 150 }           lo prende (el cron lo va sacando)
 *   { "apagar": true }                                          lo apaga
 * Sin cuerpo (el cron) es la pasada de siempre.
 */
async function orden(req) {
  if (req.method !== 'POST' || req.headers.get('x-clave') !== process.env.CALCOM_SECRET) return null;
  const cuerpo = await req.json().catch(() => null);
  if (!cuerpo || typeof cuerpo !== 'object') return null;
  if (cuerpo.previa) {
    const p = await previaBarrido(cuerpo.desde, cuerpo.hasta || null, Boolean(cuerpo.todos));
    await getStore({ name: 'matias', consistency: 'strong' }).setJSON('backfill-previa', p);
    const motivos = {};
    for (const s of p.saltear) motivos[s.motivo] = (motivos[s.motivo] || 0) + 1;
    const porOrigen = {};
    for (const a of p.abrir) porOrigen[a.origen] = (porOrigen[a.origen] || 0) + 1;
    await enCanal(`🧹 Previa del barrido desde ${cuerpo.desde.slice(0, 10)}: ${p.vistos} leads, *${p.abrir.length} recibirían apertura* (${Object.entries(porOrigen).map(([k, v]) => `${k} ${v}`).join(', ')}). Salteados: ${Object.entries(motivos).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
    return `previa: ${p.abrir.length} de ${p.vistos}`;
  }
  if (cuerpo.prender) {
    const b = await prenderBarrido({ desde: cuerpo.desde, hasta: cuerpo.hasta || null, piso: cuerpo.piso, tope: cuerpo.tope, todos: Boolean(cuerpo.todos), porDia: cuerpo.porDia });
    await enCanal(`🧹 Barrido PRENDIDO desde ${b.desde.slice(0, 10)}${b.hasta ? ` hasta ${b.hasta.slice(0, 10)}` : ''} (piso ${b.piso.slice(0, 10)}), tope ${b.tope}, ${b.porDia} por día: Matías abre a los leads viejos de a 6 por corrida, detrás de los nuevos del día, solo con plantillas con botones, y va retrocediendo mes a mes.`);
    return `prendido ${JSON.stringify(b)}`;
  }
  if (cuerpo.apagar) {
    const b = await estadoBarrido();
    await apagarBarrido();
    await enCanal(`🧹 Barrido APAGADO (llevaba ${b?.abiertos || 0} aperturas).`);
    return 'apagado';
  }
  return null;
}

export default async (req) => {
  const enviar = process.env.MATIAS_ENVIAR === '1';
  try {
    const r = await orden(req);
    if (r) { console.log(`matias barrido: ${r}`); return new Response(r, { status: 200 }); }
  } catch (e) {
    await avisarFalla('Matías (el barrido)', e, 'La orden del barrido no se pudo ejecutar.');
    return new Response('fallo, avisado', { status: 200 });
  }
  try {
    const r = await pasada({ enviar });
    console.log(`matias apertura (${enviar ? 'ENVIA' : 'sombra'}): vistos ${r.vistos}, abiertos ${r.abiertos}, propuestos ${r.propuestos}${r.barrido ? `, barrido ${JSON.stringify(r.barrido)}` : ''}${r.motivo ? `, ${r.motivo}` : ''}`);
    for (const s of r.salteados) console.log(`  salteado: ${s}`);
    return new Response('ok', { status: 200 });
  } catch (e) {
    await avisarFalla('Matías (la apertura del SDR)', e, 'Los leads nuevos no reciben el primer mensaje de Matías.');
    return new Response('fallo, avisado', { status: 200 });
  }
};
