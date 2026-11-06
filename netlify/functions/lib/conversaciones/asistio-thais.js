/*
 * LEADS EN PORTUGUÉS: DANIEL HASTA LA REUNIÓN, THAIS DESPUÉS (5-nov-2026, Ignacio).
 *
 * El lead de Brasil pasa a Thais por cualquiera de los dos caminos: la grabación de Fathom
 * (agente-llamadas) o el botón Asistió de la reunión. Este es el segundo: el blueprint
 * "status Meeting" escribe Asistio_al_Meeting en el lead, y acá se lee eso.
 *
 * De paso mantiene el tablero de Daniel (ver tablero-daniel.js): sus leads, los argentinos
 * tocados en el último día y los que figuran como Agendó. Una reunión que pasó hace 2 horas sin
 * marcar vuelve a "Reintentando asistencia". Quien pasa a Perdido a mano sale de la secuencia.
 *
 * Las escrituras van sin triggers: no despiertan reglas ni mensajes. Salir de la secuencia sí usa
 * el botón "Desactivar Blueprint": Zoho descarta los mensajes programados de esa etapa.
 */
import { get, token } from './zoho.js';
import { cambioDe, debeSalir, leadsConReunionVencida, CAMPOS, DANIEL_ID } from './tablero-daniel.js';
import { planReuniones, reunionesPorLead, CAMPOS_REUNION, CAMPOS_EVENTO, CRITERIO_EN_TABLERO } from './tablero-reuniones.js';

const API = 'https://www.zohoapis.com/crm/v6';

async function buscar(modulo, criterio, campos) {
  const out = [];
  for (let page = 1; page <= 5; page++) {
    const j = await get(`${modulo}/search?criteria=${encodeURIComponent(criterio)}&fields=${campos}&per_page=200&page=${page}`);
    out.push(...(j?.data || []));
    if (!j?.info?.more_records) break;
  }
  return out;
}

const fechaZoho = (ms) => new Date(ms).toISOString().slice(0, 19) + '+00:00';

async function sacarDeSecuencia(id, H) {
  const j = await get(`Leads/${id}/actions/blueprint`);
  const t = (j?.blueprint?.transitions || []).find((x) => x.name === 'Desactivar Blueprint');
  if (!t) return { ok: false, error: 'sin el botón Desactivar Blueprint' };
  const res = await fetch(`${API}/Leads/${id}/actions/blueprint`, {
    method: 'PUT',
    headers: H,
    body: JSON.stringify({ blueprint: [{ transition_id: t.id, data: {} }] }),
  });
  const w = await res.json().catch(() => ({}));
  if (res.ok && w.code === 'SUCCESS') return { ok: true };
  return { ok: false, error: `${w.code || res.status} ${w.message || ''}` };
}

/** escribir=false: solo dice qué cambiaría. */
export async function unaPasada({ escribir = false, ahora = Date.now() } = {}) {
  const r = { pasados: [], etapas: 0, tableros: 0, salidos: [], fallidos: [] };
  const porId = new Map();
  const sumar = (lista) => { for (const l of lista) porId.set(l.id, l); };
  sumar(await buscar('Leads', `(Owner:equals:${DANIEL_ID})`, CAMPOS));
  sumar(await buscar('Leads', `((Mobile:starts_with:+54)and(Modified_Time:greater_equal:${fechaZoho(ahora - 24 * 3600 * 1000)}))`, CAMPOS));
  sumar(await buscar('Leads', '(Etapa_Daniel:equals:Agendó)', CAMPOS));
  sumar(await buscar('Leads', '(Etapa_Daniel:equals:Perdido)', CAMPOS));
  sumar(await buscar('Leads', '(Etapa_Thais:equals:Perdido)', CAMPOS));

  const reuniones = await buscar('Events', `((Start_DateTime:greater_equal:${fechaZoho(ahora - 7 * 24 * 3600 * 1000)})and(Tipo_de_reuni_n:equals:Venta))`, CAMPOS_EVENTO);
  const vencidas = leadsConReunionVencida(reuniones, ahora);

  const leads = [...porId.values()];
  const cambios = leads.map((l) => ({ l, c: cambioDe(l, { vencida: vencidas.has(l.id) }) })).filter((x) => x.c);
  const salen = leads.filter(debeSalir);
  const contar = ({ l, c }) => {
    if (c.Owner) r.pasados.push(l.Full_Name);
    else r.etapas++;
  };
  if (!escribir) {
    cambios.forEach(contar);
    r.salidos = salen.map((l) => l.Full_Name);
    await moverTableros(reuniones, ahora, null, r);
    return r;
  }
  const H = { Authorization: `Zoho-oauthtoken ${await token()}`, 'Content-Type': 'application/json' };
  for (let i = 0; i < cambios.length; i += 100) {
    const lote = cambios.slice(i, i + 100);
    const res = await fetch(`${API}/Leads`, {
      method: 'PUT',
      headers: H,
      body: JSON.stringify({ data: lote.map(({ l, c }) => ({ id: l.id, ...c })), trigger: [] }),
    });
    const w = await res.json().catch(() => ({}));
    lote.forEach((x, n) => {
      const d = (w.data || [])[n];
      if (d?.code === 'SUCCESS') contar(x);
      else r.fallidos.push({ id: x.l.id, nombre: x.l.Full_Name, error: `${d?.code || res.status} ${d?.message || ''}` });
    });
  }
  for (const l of salen) {
    const s = await sacarDeSecuencia(l.id, H);
    if (s.ok) r.salidos.push(l.Full_Name);
    else r.fallidos.push({ id: l.id, nombre: l.Full_Name, error: s.error });
  }
  await moverTableros(reuniones, ahora, H, r);
  return r;
}

/** Tableros de Camila y Santiago y de Thais: ver tablero-reuniones.js. H null = solo cuenta. */
async function moverTableros(reuniones, ahora, H, r) {
  const porId = new Map();
  for (const l of await buscar('Leads', `(${CRITERIO_EN_TABLERO})`, CAMPOS_REUNION)) porId.set(l.id, l);
  const ids = [...reunionesPorLead(reuniones).keys()].filter((id) => !porId.has(id));
  for (let i = 0; i < ids.length; i += 100) {
    const j = await get(`Leads?ids=${ids.slice(i, i + 100).join(',')}&fields=${CAMPOS_REUNION}`);
    for (const l of j?.data || []) porId.set(l.id, l);
  }
  const plan = planReuniones([...porId.values()], reuniones, ahora);
  if (!H) { r.tableros = plan.length; return; }
  for (let i = 0; i < plan.length; i += 100) {
    const lote = plan.slice(i, i + 100);
    const res = await fetch(`${API}/Leads`, {
      method: 'PUT',
      headers: H,
      body: JSON.stringify({ data: lote.map(({ l, c }) => ({ id: l.id, ...c })), trigger: [] }),
    });
    const w = await res.json().catch(() => ({}));
    lote.forEach((x, n) => {
      const d = (w.data || [])[n];
      if (d?.code === 'SUCCESS') r.tableros++;
      else r.fallidos.push({ id: x.l.id, nombre: x.l.Full_Name, error: `${d?.code || res.status} ${d?.message || ''}` });
    });
  }
}
