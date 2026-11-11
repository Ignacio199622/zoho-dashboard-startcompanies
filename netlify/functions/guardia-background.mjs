/*
 * GUARDIA FUERA DE HORARIO, corriendo en la nube.
 *
 * Cuando alguien escribe al WhatsApp y no hay nadie atendiendo (de noche, el
 * fin de semana o un feriado de Estados Unidos), le deja la tarea al que
 * corresponde: ventas si es un lead, CX si es un cliente. Y, cuando Zoho tenga
 * los campos y las plantillas, ademas dispara el aviso automatico.
 *
 * ESTA es la que hace el trabajo; la dispara guardia.mjs, que es la programada.
 * Separadas porque cada persona son varias llamadas a Zoho y una funcion
 * sincronica de Netlify se corta a los 10 segundos.
 *
 * El "una vez por dia" se le pregunta al propio CRM (`tareaGuardiaDesde`), no a
 * un blob: asi sobrevive a que se caiga una corrida por la mitad. Lo unico que
 * guarda en un blob es quien atendio en este cierre (ver abajo).
 *
 * Lo unico que escribe en Zoho son tareas nuevas y, si los campos existen, la
 * casilla que dispara la plantilla. Nunca manda el WhatsApp por su cuenta: eso
 * lo hace Zoho con una plantilla aprobada por Meta.
 */
import { getStore } from '@netlify/blobs';
import { correrGuardia } from './lib/conversaciones/guardia-tarea.js';
import { avisarFalla, avisarResumen } from './lib/aviso-falla.js';

// Tope de la primera etapa. Bajo a proposito: si una corrida quiere tocar mas
// gente que esto, es mas probable que sea un error que una noche movida.
// Se sube cuando lleve unos dias andando limpio.
const TOPE = Number(process.env.GUARDIA_TOPE || 3);

export default async () => {
  const arranque = Date.now();
  try {
    // La unica memoria de la guardia: que conversaciones contesto una persona
    // del equipo en este cierre, para no decirles "no hay nadie conectado".
    // El resto se le sigue preguntando al CRM.
    const store = getStore({ name: 'conversaciones', consistency: 'strong' });
    const memoria = {
      leer: async () => (await store.get('guardia/atendidas', { type: 'json' })) || {},
      guardar: (datos) => store.setJSON('guardia/atendidas', datos),
      // Ultimo aviso por persona (id de ficha y ultimos 9 digitos), para no
      // mandar dos en menos de GUARDIA_HORAS_ENTRE_AVISOS (12 h).
      leerAvisos: async () => (await store.get('guardia/avisos', { type: 'json' })) || {},
      guardarAvisos: (datos) => store.setJSON('guardia/avisos', datos),
    };
    const r = await correrGuardia({ aplicar: true, tope: TOPE, memoria });

    for (const l of r.linea) console.log(l);

    if (r.abierto) return new Response('abierto', { status: 200 });

    const resumen =
      `guardia: ${r.tareas} tareas, ${r.avisos} avisos, ${r.saltados} ya tenian, ` +
      `${r.sinFicha} sin ficha` +
      // El que escribio desde otro numero se cuenta aparte: lleva tarea pero NO
      // WhatsApp (la plantilla saldria al telefono de la ficha, que no es el
      // que uso). Son 170 de 11.220 conversaciones, asi que aparece seguido.
      `${r.sinAvisoPorOtroNumero ? `, ${r.sinAvisoPorOtroNumero} desde otro numero` : ''}` +
      `${r.sinAvisoPorEquipo ? `, ${r.sinAvisoPorEquipo} ya atendidos por el equipo` : ''}` +
      `${r.sinAvisoPorSocio ? `, ${r.sinAvisoPorSocio} clientes de socio/bloqueados sin aviso` : ''}` +
      `${r.sinAvisoPorReciente ? `, ${r.sinAvisoPorReciente} con aviso hace menos de 12 h` : ''}` +
      `${r.sinAvisoPorSuHorario ? `, ${r.sinAvisoPorSuHorario} en horario habil en su pais` : ''}` +
      `, ${r.fallas || 0} fallas, ${Date.now() - arranque}ms`;
    console.log(resumen);

    // Netlify no muestra el console.log de esta funcion: en el panel se ve solo
    // la linea de arranque vacia, igual que cuando esta rota. No pude hacer que
    // aparezca. Asi que cuando la guardia HACE algo, lo cuenta donde el equipo
    // si lo va a ver. Las corridas en las que no paso nada no se avisan: serian
    // 144 mensajes por dia y nadie las leeria.
    // Antes esto miraba solo los avisos, y una corrida que crea TAREAS sin
    // mandar ningun WhatsApp no aparecia en ningun lado. Es justo el caso del
    // que ya esta en una cadencia, del que ya cerro la conversacion y del que
    // escribio desde otro numero: la persona quedo esperando, hay una tarea
    // nueva, y el equipo no se enteraba. Si hubo trabajo, se cuenta.
    if (r.tareas > 0 || r.avisos > 0 || r.fallas > 0) {
      await avisarResumen('La guardia de fuera de horario', resumen, r.linea);
    }
    // ALARMA DE TRABADA (11-nov-2026, feriado): todo el dia corrio con 37-44
    // esperando y dio "0 tareas, 0 avisos" en silencio; nos enteramos porque
    // un cliente (Jacobo Mizrahi) no recibio nada. Si quedo gente sin mirar o
    // habia nuevos y la corrida no hizo nada, algo la esta frenando. Va por
    // avisarFalla, que repite el mismo aviso a lo sumo una vez por hora.
    else if ((r.sinRevisar > 0 || r.nuevos > 0) && r.tareas === 0 && r.avisos === 0) {
      await avisarFalla(
        'La guardia de fuera de horario',
        new Error(`TRABADA: ${r.nuevos || 0} nuevos y ${r.sinRevisar || 0} sin revisar, pero 0 tareas y 0 avisos`),
        'Hay gente esperando fuera de horario y la guardia no les crea tarea ni aviso. Revisar los logs de guardia-background.'
      );
    }
    return new Response('ok', { status: 200 });
  } catch (e) {
    // Que falle es una cosa; que falle en silencio es la que deja al equipo
    // creyendo que no habia nada pendiente. Y en Netlify el console.error de
    // esta funcion no aparece en los logs: sin el aviso a Slack, una corrida
    // rota y una sana se ven exactamente igual.
    await avisarFalla(
      'La guardia de fuera de horario',
      e,
      'Si varios agentes fallan juntos, sospechar del token de Zoho antes que del codigo.'
    );
    return new Response(String(e?.message || e), { status: 500 });
  }
};
