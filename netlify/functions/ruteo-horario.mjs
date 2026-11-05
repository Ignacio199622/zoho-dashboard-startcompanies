// Ruteo en horario: cada 10 minutos aplica el Estado_pendiente de los leads cuando es de día en su
// país (ver lib/ruteo-horario.js). Avisa en #control-crm solo si algo falla.
import { env } from './lib/entorno.js';
import { tokenActual } from './lib/control-crm/zoho.js';
import { avisarFalla } from './lib/aviso-falla.js';
import { decidir } from './lib/ruteo-horario.js';

const API = 'https://www.zohoapis.com/crm/v6';
const ETAPAS = ['Captación', 'Nurturing', 'Retargeting', 'Retargeting Lili', 'Agendamiento'];
const CRITERIO = '(' + ETAPAS.map((e) => `(Estado_pendiente:equals:${e})`).join('or') + ')';
const APLICAR = env.RUTEO_HORARIO_APLICAR !== '0';

export default async () => {
  try {
    const H = { Authorization: `Zoho-oauthtoken ${await tokenActual()}`, 'Content-Type': 'application/json' };
    const leads = [];
    for (let page = 1; page <= 5; page++) {
      const r = await fetch(`${API}/Leads/search?criteria=${encodeURIComponent(CRITERIO)}&fields=Full_Name,Lead_Status,Estado_pendiente,reserva,Mobile,Phone,Created_Time,Modified_Time&per_page=200&page=${page}`, { headers: H });
      if (r.status === 204) break;
      const j = await r.json();
      if (!j.data) throw new Error(`búsqueda Zoho: ${JSON.stringify(j).slice(0, 160)}`);
      leads.push(...j.data);
      if (!j.info?.more_records) break;
    }
    const plan = leads.map((l) => ({ l, d: decidir(l) })).filter((x) => x.d);
    const aplicar = plan.filter((x) => x.d.accion === 'aplicar');
    const limpiar = plan.filter((x) => x.d.accion === 'limpiar');
    const fallas = [];
    if (APLICAR) {
      // Primero el estado (CON workflows y blueprint: arrancan las cadencias como siempre), recién
      // después se borra el pendiente SIN workflows, para no despertar nada más.
      for (let i = 0; i < aplicar.length; i += 20) {
        const lote = aplicar.slice(i, i + 20);
        const j = await (await fetch(`${API}/Leads`, { method: 'PUT', headers: H, body: JSON.stringify({ data: lote.map((x) => ({ id: x.l.id, Lead_Status: x.l.Estado_pendiente })), trigger: ['workflow', 'blueprint'] }) })).json();
        (j.data || []).forEach((d, n) => { if (d.code !== 'SUCCESS') fallas.push(`${lote[n].l.Full_Name}: ${d.code} ${d.message || ''}`); });
      }
      const borrar = [...aplicar, ...limpiar];
      for (let i = 0; i < borrar.length; i += 100) {
        await fetch(`${API}/Leads`, { method: 'PUT', headers: H, body: JSON.stringify({ data: borrar.slice(i, i + 100).map((x) => ({ id: x.l.id, Estado_pendiente: null })), trigger: [] }) });
      }
    }
    const resumen = { pendientes: leads.length, aplicados: aplicar.length, limpiados: limpiar.length, esperan: plan.length - aplicar.length - limpiar.length, fallas, detalle: plan.map((x) => `${x.l.Full_Name} → ${x.l.Estado_pendiente}: ${x.d.accion} (${x.d.motivo})`) };
    console.log('ruteo-horario', JSON.stringify(resumen));
    if (fallas.length) await avisarFalla('Ruteo en horario', new Error(fallas.slice(0, 5).join(' · ')), 'netlify/functions/ruteo-horario.mjs');
    return new Response(JSON.stringify(resumen), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    await avisarFalla('Ruteo en horario', e, 'netlify/functions/ruteo-horario.mjs · si Zoho dice que Estado_pendiente no existe, falta el campo');
    return new Response('fallo', { status: 500 });
  }
};

export const config = { schedule: '*/10 * * * *' };
