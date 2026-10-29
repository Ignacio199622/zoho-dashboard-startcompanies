/*
 * Le pone canal (Lead_Source, "Fuente") al cliente deduciendolo del calendario donde reservo.
 *
 * POR QUE EXISTE. El cliente que crea el portal no tiene lead detras: cruzar los
 * 1.073 clientes contra los 8.466 leads da CERO coincidencias por mail y 20 por
 * telefono (3 utiles). Medido dos veces, ese camino esta agotado. Pero 395
 * clientes tienen una reunion agendada, y la reunion dice en que calendario.
 *
 * LA REGLA SE APRENDE, NO SE INVENTA: para cada calendario se mira que canal
 * traian los leads que reservaron ahi, y solo se usa si es contundente (>=8
 * reservas, >=75% del mismo canal). Ver src/calendario.js.
 *
 * Escribe SOLO en clientes sin canal. La copia al trato la hace origen-tratos.
 *
 * TRES FRENOS: tope por corrida, timeline despues de CADA escritura, e
 * interruptor `canal-clientes-apagado`.
 */
import { getStore } from '@netlify/blobs';
import { traer, huboEnvios } from './lib/pasada-origen.js';
import { aprenderRegla, planificarClientes } from './lib/calendario.js';
import { tokenZoho } from './lib/aprobacion.js';
import { dormir } from './lib/reintentar.js';

const API = 'https://www.zohoapis.com/crm/v6';
const MAX_POR_CORRIDA = 40;
const MAX_BITACORA = 40;

export default async () => {
  const store = getStore({ name: 'agente-llamadas', consistency: 'strong' });
  const inicio = new Date();
  const errores = [];
  const avisos = [];
  let escritos = 0;
  let candidatos = 0;
  let calendariosUsables = 0;

  const cerrar = async () => {
    const reg = {
      agente: 'canal-clientes',
      inicio: inicio.toISOString(),
      segundos: Math.round((Date.now() - inicio) / 1000),
      candidatos,
      escritos,
      calendariosUsables,
      errores,
      avisos,
      estado: errores.length ? (escritos ? 'con errores' : 'fallo') : 'ok',
    };
    try {
      const b = (await store.get('bitacora-canal-clientes', { type: 'json' })) || [];
      await store.setJSON('bitacora-canal-clientes', [reg, ...b].slice(0, MAX_BITACORA));
    } catch (e) {
      console.error('no se pudo guardar la bitacora', e);
    }
    console.log(JSON.stringify(reg));
    return new Response(JSON.stringify(reg), { headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const apagado = await store.get('canal-clientes-apagado', { type: 'json' });
    if (apagado) {
      avisos.push(`apagado el ${String(apagado.cuando).slice(0, 16)}: ${apagado.motivo}`);
      return await cerrar();
    }

    const H = { Authorization: `Zoho-oauthtoken ${await tokenZoho()}` };
    const [ev, leads, contactos] = await Promise.all([
      traer(H, 'Events', 'id,Event_Title,Start_DateTime,Created_Time,Who_Id,What_Id'),
      traer(H, 'Leads', 'id,Full_Name,Lead_Source,Calendario'),
      traer(H, 'Contacts', 'id,Full_Name,Email,Landing_Origen,Lead_Source'),
    ]);

    const { regla, filas } = aprenderRegla(ev, leads);
    calendariosUsables = Object.keys(regla).length;
    if (!calendariosUsables) {
      // Nunca deberia pasar. Si pasa, algo se rompio aguas arriba (los leads
      // dejaron de traer canal) y conviene que quede escrito, no que pase mudo.
      avisos.push(`ningun calendario alcanzo el umbral sobre ${filas.length} distintos: revisar si los leads siguen trayendo canal`);
      return await cerrar();
    }

    const { plan, noConcluyente, conReunion } = planificarClientes(ev, contactos, regla);
    candidatos = plan.length;
    avisos.push(`${conReunion} clientes con reunion, ${noConcluyente} con calendario no concluyente`);
    if (!plan.length) return await cerrar();

    for (const p of plan.slice(0, MAX_POR_CORRIDA)) {
      const t0 = Date.now();
      try {
        const r = await fetch(`${API}/Contacts`, {
          method: 'PUT',
          headers: { ...H, 'Content-Type': 'application/json' },
          // 18-sep-2026: el canal va a Lead_Source ("Fuente"); trigger vacio para no despertar reglas.
          body: JSON.stringify({ data: [{ id: p.id, Lead_Source: p.canal }], trigger: [] }),
        });
        const d = ((await r.json()).data || [])[0];
        if (d?.code !== 'SUCCESS') throw new Error(`${d?.code} ${d?.message}`);
        escritos++;

        const envios = await huboEnvios(H, 'Contacts', p.id, t0 - 5000);
        if (envios.length) {
          await store.setJSON('canal-clientes-apagado', {
            cuando: new Date().toISOString(),
            motivo: `editar el cliente ${p.id} disparo ${envios.length} mensaje(s)`,
          });
          errores.push({ paso: 'corte', mensaje: `disparo ${envios.length} envios en ${p.id}: se apago solo` });
          return await cerrar();
        }
        await dormir(350);
      } catch (e) {
        errores.push({ paso: 'escribir', cliente: p.id, mensaje: String(e.message).slice(0, 160) });
      }
    }

    if (plan.length > MAX_POR_CORRIDA) avisos.push(`quedaron ${plan.length - MAX_POR_CORRIDA} para mañana`);
    return await cerrar();
  } catch (e) {
    errores.push({ paso: 'corrida', mensaje: String(e.message).slice(0, 300) });
    return await cerrar();
  }
};
