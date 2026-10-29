/*
 * RECUPERAR LEADS DORMIDOS, corriendo en la nube.
 *
 * Hasta julio de 2026 el lead que llegaba por chat no entraba a ninguna
 * cadencia. Quedaron cientos tirados en "En Calificación" y "Nuevo MQL". Esto
 * los mete a Captación de a 2 por dia habil.
 *
 * El ritmo sale de la cadencia: cada lead recibe 3 WhatsApp (dias 000, 002 y
 * 006) y 2 mails. Como las tandas se superponen, en regimen salen
 * `leads por dia x 3` mensajes diarios. 2 leads = 6 WhatsApp por dia, sobre un
 * numero que Meta ya bloqueo una vez.
 *
 * Escribe UN campo por lead, `Lead_Status = Captación`. Todo lo demas lo hace
 * la regla `Flujo Captación Crear Editar`, que ya existia.
 */
import { paraHoy, POR_DIA } from './lib/conversaciones/recuperar.js';
import { mandarACaptacion } from './lib/conversaciones/escritura.js';

const CUANTOS = Number(process.env.RECUPERAR_POR_DIA || POR_DIA);

export default async () => {
  try {
    const { abierto, mueve, descartados, quedan } = await paraHoy({ cuantos: CUANTOS });

    if (!abierto) {
      console.log('recuperar: hoy no se mueve nadie (fuera de horario, finde o feriado)');
      return new Response('cerrado', { status: 200 });
    }

    for (const d of descartados) console.log(`recuperar: ${d.Full_Name} salteado, ${d.porque}`);

    let hechos = 0;
    for (const l of mueve) {
      const r = await mandarACaptacion(l.id);
      if (r.ok) {
        hechos++;
        console.log(`recuperar: OK ${l.Full_Name} (${String(l.Created_Time).slice(0, 10)}) -> Captación`);
      } else {
        console.error(`recuperar: MAL ${l.Full_Name} quedo en "${r.estado}"`);
      }
    }
    console.log(`recuperar: ${hechos} movidos, quedan ${quedan - hechos}`);
    return new Response('ok', { status: 200 });
  } catch (e) {
    // Que falle en silencio es lo peor: el backlog dejaria de moverse y nadie
    // se enteraria hasta dentro de meses.
    console.error('recuperar: la corrida fallo', e);
    return new Response(String(e?.message || e), { status: 500 });
  }
};
