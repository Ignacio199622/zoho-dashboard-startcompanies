/*
 * Mantiene la atribucion armada, sola, cada hora.
 *
 * POR QUE EXISTE: el canal y la plata viven en modulos distintos y ninguno
 * tenia los dos. El importe esta en el trato (80%), el canal estaba en el trato
 * en el 0%. Sin una fila que tenga las dos cosas no hay CAC por canal ni churn
 * por origen. Se hizo una pasada historica a mano; esto es para que los tratos
 * NUEVOS no vuelvan a nacer sin origen y haya que repetirla cada tres meses.
 *
 * Hace dos cosas, en orden, porque la segunda depende de la primera:
 *   1. ATAR   el trato huerfano a su cliente, via la cuenta, si es inequivoco
 *   2. COPIAR el origen del cliente al trato
 *
 * NO ADIVINA NADA. Solo escribe cuando la respuesta es una sola: si la cuenta
 * tiene dos contactos no elige, y nunca pisa un campo que ya tiene valor.
 *
 * LO QUE NO PUEDE ARREGLAR: el cliente que el portal crea de cero, sin lead
 * detras, no tiene origen que copiar. Son 687 y crecen ~30 por mes. Eso se
 * arregla en el portal, no aca.
 *
 * TRES FRENOS, porque esto edita tratos:
 *   1. Tope por corrida.
 *   2. Mira el timeline despues de CADA escritura y corta si sale un mensaje.
 *   3. Interruptor: el blob `origen-apagado` la deja quieta sin deployar.
 */
import { getStore } from '@netlify/blobs';
import { planificar, aplicar } from './lib/pasada-origen.js';
import { tokenZoho } from './lib/aprobacion.js';

const MAX_ATAR = 8;
const MAX_COPIAR = 12;
const DIAS_ATRAS = 30; // los viejos ya se hicieron a mano; esto vigila lo nuevo
const MAX_BITACORA = 60;

export default async () => {
  const store = getStore({ name: 'agente-llamadas', consistency: 'strong' });
  const inicio = new Date();
  const errores = [];
  const avisos = [];
  let atados = 0;
  let copiados = 0;
  let pendientes = 0;

  const cerrar = async () => {
    const reg = {
      agente: 'origen-tratos',
      inicio: inicio.toISOString(),
      segundos: Math.round((Date.now() - inicio) / 1000),
      atados,
      copiados,
      pendientes,
      errores,
      avisos,
      estado: errores.length ? (atados + copiados ? 'con errores' : 'fallo') : 'ok',
    };
    try {
      const b = (await store.get('bitacora-origen', { type: 'json' })) || [];
      await store.setJSON('bitacora-origen', [reg, ...b].slice(0, MAX_BITACORA));
    } catch (e) {
      console.error('no se pudo guardar la bitacora', e);
    }
    return new Response(JSON.stringify(reg), { headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const apagado = await store.get('origen-apagado', { type: 'json' });
    if (apagado) {
      avisos.push(`apagado el ${String(apagado.cuando).slice(0, 16)}: ${apagado.motivo}`);
      return await cerrar();
    }

    const H = { Authorization: `Zoho-oauthtoken ${await tokenZoho()}` };
    const desde = new Date(Date.now() - DIAS_ATRAS * 24 * 3600e3).toISOString().slice(0, 10);
    const plan = await planificar(H, { desde, maxPaginasTratos: 3 });

    pendientes = plan.atar.length + plan.copiar.length;
    if (!pendientes) {
      avisos.push('nada nuevo para atribuir');
      return await cerrar();
    }

    const r = await aplicar(H, plan, {
      maxAtar: MAX_ATAR,
      maxCopiar: MAX_COPIAR,
      alCortar: async (ev) => {
        await store.setJSON('origen-apagado', {
          cuando: new Date().toISOString(),
          motivo: `editar el trato ${ev.trato} (${ev.etiqueta}) disparo ${ev.envios} mensaje(s)`,
        });
      },
    });

    atados = r.atados;
    copiados = r.copiados;
    errores.push(...r.errores);
    if (r.cortado) errores.push({ paso: 'corte', mensaje: `disparo ${r.cortado.envios} envios en ${r.cortado.trato}: se apago solo` });

    const resto = plan.atar.length - r.atados + (plan.copiar.length - r.copiados);
    if (!r.cortado && resto > 0) avisos.push(`quedaron ${resto} para la proxima`);

    return await cerrar();
  } catch (e) {
    errores.push({ paso: 'corrida', mensaje: String(e.message).slice(0, 300) });
    return await cerrar();
  }
};

// A y 45. Las otras corren en punto, y cuarto y y media.
export const config = { schedule: '45 * * * *' };
