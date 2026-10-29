/*
 * Le pone la Fuente (el canal de origen) a los leads nuevos, sola, cada hora.
 *
 * DESDE LA NORMALIZACION DEL 18-sep-2026 escribe `Lead_Source` ("Fuente"), que
 * es el campo del canal. Antes escribia `Landing_Origen`, que ahora guarda la
 * pagina por donde entro (y de ahi se LEE el slug). Tambien reemplaza las
 * fuentes transitorias que dejan las integraciones (WHATSAPP - ..., Chatbot,
 * Instagram Bot) por el canal real, o por "Sin origen de fuente" (antes "WhatsApp (no sabemos)") si no hay
 * ninguna señal, y suma el Canal de contacto que corresponde.
 *
 * REEMPLAZA A LO QUE SE ROMPIO. Hasta la ultima semana de julio algo llenaba
 * `Landing_Origen` al 90-95%. Entre el 27-jul y el 3-ago dejo de correr y el
 * campo se cayo al 4% en agosto, sin que nadie lo notara porque en el mismo
 * periodo mejoraron las etiquetas (70% -> 98%) y empezaron a llegar los utm.
 * Nadie sabe que era ni por que se apago; esto lo hace desde afuera.
 *
 * NO CONSULTA NADA EXTERNO. Todo sale de campos que ya estan en la ficha:
 * utm_source, fbclid, creativeId, Social_Lead_ID y `Calendario` (el slug de la
 * landing). Ver src/canal.js para el orden de las señales y por que.
 *
 * DESDE EL 21-sep-2026 tambien lee las marcas del anuncio que quedaron
 * escondidas en `First_Visited_URL` (SalesIQ) o en la linea "Pagina:" de
 * Description (el chatbot): fbclid y utm_*. El chatbot crea el lead con esos
 * campos vacios y la URL entera al lado, y asi una persona que vino de un
 * anuncio de IG quedaba como "SEO / Web Organica" (caso Vanessa Marmolejo,
 * 19-sep). Lo que encuentra en la URL lo copia a los campos vacios, para que
 * la atribucion por anuncio quede en la ficha y no solo en el texto.
 *
 * Escribe `Lead_Source` solo cuando esta vacio o es transitorio, y suma
 * valores a `Canal_de_contacto`. Nunca pisa un canal ya resuelto.
 *
 * CUATRO FRENOS, porque esto edita leads y editar un lead en este CRM puede
 * disparar un mensaje al cliente:
 *   0. NO se escribe un lead que este dentro de un flujo de mensajes. Es el
 *      freno que importa: los otros tres miran DESPUES de escribir, y las
 *      tandas de WhatsApp salen hasta un dia habil mas tarde.
 *   1. Tope por corrida. Prefiere tardar tres horas antes que hacer 60
 *      escrituras seguidas.
 *   2. Mira el timeline despues de CADA escritura y corta la corrida entera si
 *      salio un mensaje.
 *   3. Interruptor: si existe el blob `canal-apagado`, no escribe nada. Sirve
 *      para pararlo sin deployar.
 */
import { getStore } from '@netlify/blobs';
import { canalDelLead, fuenteSinSenal, canalesDeContacto, marcasDeUrl, FUENTES_TRANSITORIAS, CAMPOS } from './lib/canal.js';
import { seguroEditar, CAMPOS_SEGURIDAD } from './lib/seguridad-leads.js';
import { tokenZoho } from './lib/aprobacion.js';
import { dormir } from './lib/reintentar.js';

const API = 'https://www.zohoapis.com/crm/v6';
const MAX_POR_CORRIDA = 8;
const DIAS_ATRAS = 10; // margen de sobra: entran ~10 leads mapeables por dia
const MAX_BITACORA = 60;

export default async () => {
  const store = getStore({ name: 'agente-llamadas', consistency: 'strong' });
  const inicio = new Date();
  const errores = [];
  const avisos = [];
  let escritas = 0;
  let candidatos = 0;

  const cerrar = async (extra = {}) => {
    const reg = {
      agente: 'canal-leads',
      inicio: inicio.toISOString(),
      segundos: Math.round((Date.now() - inicio) / 1000),
      candidatos,
      escritas,
      errores,
      avisos,
      estado: errores.length ? (escritas ? 'con errores' : 'fallo') : 'ok',
      ...extra,
    };
    try {
      const b = (await store.get('bitacora-canal', { type: 'json' })) || [];
      await store.setJSON('bitacora-canal', [reg, ...b].slice(0, MAX_BITACORA));
    } catch (e) {
      console.error('no se pudo guardar la bitacora', e);
    }
    return new Response(JSON.stringify(reg), { headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const apagado = await store.get('canal-apagado', { type: 'json' });
    if (apagado) {
      avisos.push(`apagado el ${String(apagado.cuando).slice(0, 16)}: ${apagado.motivo}`);
      return await cerrar();
    }

    const t = await tokenZoho();
    const H = { Authorization: `Zoho-oauthtoken ${t}` };

    const desde = new Date(Date.now() - DIAS_ATRAS * 24 * 3600e3).toISOString().slice(0, 10);
    // Ordenado por fecha de creacion descendente: se corta al salir de ventana.
    const leads = [];
    for (let page = 1; page <= 3; page++) {
      const r = await fetch(`${API}/Leads?fields=${CAMPOS},${CAMPOS_SEGURIDAD.join(',')}&per_page=200&page=${page}&sort_by=Created_Time&sort_order=desc`, { headers: H });
      if (r.status === 204) break;
      const j = await r.json();
      const lote = j.data || [];
      leads.push(...lote);
      if (!j.info?.more_records) break;
      if (lote.length && (lote[lote.length - 1].Created_Time || '') < desde) break;
    }

    const plan = [];
    let frenados = 0;
    for (const l of leads) {
      if ((l.Created_Time || '') < desde) continue;
      const transitoria = FUENTES_TRANSITORIAS.test(String(l.Lead_Source || ''));
      if (l.Lead_Source && !transitoria) continue; // nunca se pisa un canal ya resuelto
      let { canal, via } = canalDelLead(l);
      if (!canal) { canal = fuenteSinSenal(l); if (canal) via = `sin señal: ${l.Lead_Source || '(vacía)'} -> ${canal}`; }
      // 29-sep-2026: sin canal igual se guarda la pagina (Landing de Origen) si la URL la trae.
      if (!canal && l.Lead_Source && marcasDeUrl(l).Landing_Origen) { canal = l.Lead_Source; via = 'sin canal: solo se guarda la pagina'; }
      if (!canal) continue;
      // 12-oct-2026: "Sin origen de fuente" es transitoria (se re-resuelve si aparece señal), pero si
      // la pasada vuelve a dar lo mismo no se reescribe en cada corrida.
      if (canal === l.Lead_Source && !via?.startsWith('sin canal')) continue;
      // Editar un lead puede arrancarle una tanda de WhatsApp, y el mensaje
      // sale hasta un dia habil despues: el chequeo del timeline de mas abajo
      // no llega a verlo. Por eso el filtro va ANTES de escribir, no despues.
      // Ver lib/seguridad-leads.js.
      const s = seguroEditar(l);
      if (!s.seguro) { frenados++; continue; }
      const contacto = canalesDeContacto(l);
      // Solo los campos vacios: nunca pisa un dato que llego por el camino normal.
      const deUrl = marcasDeUrl(l);
      plan.push({ l, canal, via, contacto, deUrl });
    }
    candidatos = plan.length;
    if (frenados) avisos.push(`${frenados} lead(s) no se tocaron: estan dentro de un flujo de mensajes`);
    if (!plan.length) avisos.push('no habia leads nuevos para mapear');

    for (const p of plan.slice(0, MAX_POR_CORRIDA)) {
      const t0 = Date.now();
      try {
        const r = await fetch(`${API}/Leads`, {
          method: 'PUT',
          headers: { ...H, 'Content-Type': 'application/json' },
          // trigger: [] = ninguna regla se despierta con esta edicion. El
          // filtro seguroEditar sigue igual, por si algun dia esto se saca.
          body: JSON.stringify({ data: [{ id: p.l.id, Lead_Source: p.canal, Canal_de_contacto: p.contacto, ...p.deUrl }], trigger: [] }),
        });
        const d = ((await r.json()).data || [])[0];
        if (d?.code !== 'SUCCESS') throw new Error(`${d?.code} ${d?.message}`);
        escritas++;

        const tl = await fetch(`${API}/Leads/${p.l.id}/__timeline?per_page=25`, { headers: H });
        const eventos = tl.ok ? (await tl.json()).__timeline || [] : [];
        const envios = eventos.filter(
          (x) =>
            new Date(x.audited_time).getTime() >= t0 - 5000 &&
            /messagenotificationsent|email_notification|notification/i.test(x.action || '')
        );
        if (envios.length) {
          await store.setJSON('canal-apagado', {
            cuando: new Date().toISOString(),
            motivo: `editar el lead ${p.l.id} disparo ${envios.length} mensaje(s) al cliente`,
          });
          errores.push({ paso: 'corte', mensaje: `disparo ${envios.length} envios en ${p.l.id}: se apago solo` });
          return await cerrar();
        }
        await dormir(400);
      } catch (e) {
        errores.push({ paso: 'escribir', lead: p.l.id, mensaje: String(e.message).slice(0, 160) });
      }
    }

    if (plan.length > MAX_POR_CORRIDA) avisos.push(`quedaron ${plan.length - MAX_POR_CORRIDA} para la proxima corrida`);
    return await cerrar();
  } catch (e) {
    errores.push({ paso: 'corrida', mensaje: String(e.message).slice(0, 300) });
    return await cerrar();
  }
};

// A y cuarto: agente-llamadas corre en punto y el coach a y media.
export const config = { schedule: '15 * * * *' };
