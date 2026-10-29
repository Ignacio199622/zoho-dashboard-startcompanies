/*
 * El unico pedazo de Control CRM que ESCRIBE en Zoho.
 *
 * Problema que resuelve (7-sep-2026): cuando un cliente escribe por WhatsApp
 * desde un numero que en su ficha esta guardado en otro formato, Zoho no lo
 * reconoce, crea un lead nuevo y le arranca la cadencia de captacion. El
 * cliente termina recibiendo "te cuento como abrir tu LLC" meses despues de
 * haberla abierto. Ese dia habia 6 clientes con el mensaje ya programado.
 *
 * La regla `lead-de-cliente` ya los detectaba y avisaba, pero con 20 casos
 * permanentes en el canal el aviso se volvio ruido de fondo y nadie actuaba.
 * Esto lo convierte en accion.
 *
 * COMO IDENTIFICA: compara los ULTIMOS 8 DIGITOS del telefono. Asi da igual el
 * 9 argentino, el 1 mexicano y el 0 troncal, y no depende de que la base este
 * normalizada.
 *
 * COMO FRENA: hacen falta LOS DOS PASOS, y en este orden.
 *
 *   1. La transicion de blueprint "Desactivar Blueprint" -> "Fuera de flujo".
 *      El Lead_Status esta gobernado por un blueprint, asi que un PUT normal lo
 *      rebota con RECORD_IN_BLUEPRINT.
 *
 *   2. Vaciar Fecha_Siguiente_Mensaje, con trigger:[] para no despertar nada.
 *
 * El paso 2 no es adorno, es el que de verdad corta el envio: hay CINCO reglas
 * que disparan `date_or_datetime` sobre ese campo (Flujo Retargeting, APERTURA -
 * Flujo retargeting 1er mensaje, CUENTA BANCARIA - Retargeting Relay y dos de
 * RENOVACIONES). Mientras la fecha siga en el futuro, el mensaje puede salir
 * aunque el lead ya no este en ninguna cadencia. Se vio en vivo el 7-sep: tres
 * leads quedaron en "Fuera de flujo" con la fecha intacta.
 *
 * Y el paso 1 tampoco alcanza solo por otra razon: la transicion cuenta como
 * edicion y despierta las reglas create_or_edit. A un lead se lo vio volver a
 * "Captación" UN SEGUNDO despues de sacarlo. Sin fecha no puede mandar nada,
 * vuelva al estado que vuelva.
 *
 * NO usar la transicion "Desactivar Retargeting": lleva a "Nurturing", que es
 * otra cadencia. Sacaria al cliente de una tanda para meterlo en la siguiente.
 *
 * LIMITES DE SEGURIDAD, en orden de importancia:
 *   - solo toca leads con un mensaje REALMENTE pendiente (fecha futura). Un
 *     duplicado dormido no molesta a nadie y no se toca.
 *   - TOPE por corrida. Si un dia aparecen 200, algo se rompio antes: es mejor
 *     que frene 15 y avise, a que haga una pasada masiva sin que nadie mire.
 *   - se apaga con FRENAR_CLIENTES=0 sin tocar codigo ni redeployar la logica.
 */
const TOPE = 15;
const TRANSICION = '6698625000053356076';        // "Desactivar Blueprint" -> Fuera de flujo
const ESTADO_SEGURO = 'Fuera de flujo';   // a donde lleva la transicion

const clave = (t) => { const d = String(t || '').replace(/\D/g, ''); return d.length >= 8 ? d.slice(-8) : null; };

/** Los leads que son clientes y tienen un mensaje automatico por salir. */
export function aFrenar({ leads, contactos, llcs }) {
  const clientes = new Map();
  for (const c of contactos) for (const f of ['Mobile', 'Phone']) {
    const k = clave(c[f]);
    if (k && !clientes.has(k)) clientes.set(k, { t: 'Contacto', n: c.Full_Name, id: c.id });
  }
  for (const a of llcs) for (const f of ['Phone', 'Mobile']) {
    const k = clave(a[f]);
    if (k && !clientes.has(k)) clientes.set(k, { t: 'LLC', n: a.Account_Name, id: a.id });
  }
  const ahora = Date.now();
  const out = [];
  for (const l of leads) {
    /*
     * El filtro es la FECHA, no el estado. Un lead ya en "Fuera de flujo" pero
     * con la fecha en el futuro sigue siendo peligroso, porque las cinco reglas
     * que disparan por Fecha_Siguiente_Mensaje no miran el Lead_Status. Filtrar
     * por estado dejaba pasar justo esos: el 7-sep quedaron tres asi.
     */
    const f = l.Fecha_Siguiente_Mensaje ? new Date(l.Fecha_Siguiente_Mensaje).getTime() : 0;
    if (!f || f <= ahora) continue;                       // sin mensaje por salir, no urge
    let hit = null;
    for (const campo of ['Mobile', 'Phone']) {
      const k = clave(l[campo]);
      if (k && clientes.has(k)) { hit = clientes.get(k); break; }
    }
    if (hit) out.push({ id: l.id, lead: l.Full_Name, estado: l.Lead_Status, cliente: hit, cuando: l.Fecha_Siguiente_Mensaje });
  }
  return out.sort((a, b) => new Date(a.cuando) - new Date(b.cuando));
}

/** Ejecuta la transicion. Devuelve el resumen para contarlo en Slack. */
export async function frenar(datos, { token, seco = false } = {}) {
  if (process.env.FRENAR_CLIENTES === '0') return { apagado: true, candidatos: 0, frenados: [], fallos: [] };
  const todos = aFrenar(datos);
  const lote = todos.slice(0, TOPE);
  const frenados = [], fallos = [];
  for (const c of lote) {
    if (seco) { frenados.push(c); continue; }
    const cab = { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' };
    try {
      // 1. sacarlo del blueprint
      const r = await fetch(`https://www.zohoapis.com/crm/v6/Leads/${c.id}/actions/blueprint`, {
        method: 'PUT', headers: cab,
        body: JSON.stringify({ blueprint: [{ transition_id: TRANSICION, data: {} }] }),
      });
      const d = (await r.json()).data?.[0] || {};
      const salio = d.code === 'SUCCESS';

      // 2. apagar el disparador por fecha. Va DESPUES, porque la transicion
      //    dispara reglas que pueden reescribir el campo, y con trigger:[] para
      //    que este PUT no despierte a nadie.
      const r2 = await fetch('https://www.zohoapis.com/crm/v6/Leads', {
        method: 'PUT', headers: cab,
        body: JSON.stringify({ data: [{ id: c.id, Fecha_Siguiente_Mensaje: null }], trigger: [] }),
      });
      const d2 = (await r2.json()).data?.[0] || {};
      const sinFecha = d2.code === 'SUCCESS';

      // La fecha es la que manda: sin ella no sale el mensaje, aunque la
      // transicion haya fallado o una regla lo devuelva a la cadencia.
      if (sinFecha) frenados.push({ ...c, salioDelFlujo: salio });
      else fallos.push({ ...c, por: `no pude vaciar la fecha: ${d2.code || r2.status} ${String(d2.message || '').slice(0, 60)}` });
    } catch (e) {
      fallos.push({ ...c, por: String(e.message).slice(0, 80) });
    }
  }
  return { apagado: false, candidatos: todos.length, excedente: Math.max(0, todos.length - TOPE), frenados, fallos };
}

/** El parrafo para el mensaje de Slack. Vacio si no hubo nada que hacer. */
export function textoFreno(res) {
  if (!res || res.apagado || (!res.frenados.length && !res.fallos.length)) return '';
  const l = [];
  if (res.frenados.length) {
    l.push(`:octagonal_sign: *Frené la cadencia de ${res.frenados.length} cliente${res.frenados.length > 1 ? 's' : ''}* que iba a recibir el pitch de apertura:`);
    for (const c of res.frenados.slice(0, 8)) l.push(`   • ${c.lead || 'sin nombre'} — ya es ${c.cliente.t} ${c.cliente.n}`);
    if (res.frenados.length > 8) l.push(`   • y ${res.frenados.length - 8} más`);
    l.push('   _Quedaron en "Fuera de flujo". Si alguno era un lead de verdad, devolvelo al flujo a mano._');
  }
  if (res.excedente) l.push(`:warning: Habia ${res.candidatos} en total y el tope por corrida es ${res.candidatos - res.excedente}. Quedan ${res.excedente} para la proxima: si el numero no baja, algo se rompio antes.`);
  if (res.fallos.length) {
    l.push(`:x: No pude frenar ${res.fallos.length}:`);
    for (const f of res.fallos.slice(0, 5)) l.push(`   • ${f.lead || 'sin nombre'} — ${f.por}`);
  }
  return l.join('\n');
}
