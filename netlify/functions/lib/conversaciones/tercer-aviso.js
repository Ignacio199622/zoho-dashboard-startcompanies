/*
 * LOS DOS AVISOS DEL DÍA DE LA REUNIÓN. Una sola pasada, una sola lectura del CRM.
 *
 *   4 h antes  →  "tenemos la agenda completa"  →  SOLO a los que NO contestaron el Sí/No
 *   3 h antes  →  recordatorio                  →  SOLO a los que YA confirmaron
 *
 * Nadie recibe los dos: son audiencias complementarias. Si se lo mandáramos a todos, el
 * mudo recibiría tres mensajes en cuatro horas (4 h, 3 h y el de 30 min).
 *
 * Lo medido antes de construirlo (Ignacio, 23-sep-2026, mirando el calendario lleno de
 * amarillos: "qué hacemos con estos que ocupan el calendario y no confirman"):
 *   - El amarillo NO es peso muerto: asiste el 45% (30 de 66, 21 días). El que confirma,
 *     77%. El que dice "no asiste", 0 de 8. Cancelarlos tiraría reuniones reales; lo que
 *     sirve es que el que no va lo diga a tiempo, porque ahí el hueco se libera solo.
 *   - Insistir funciona y no se agota: de 55 reuniones el 1er toque saca 33% de respuestas
 *     y el 2do saca otro 38% DE LOS QUE QUEDABAN. Por eso un 3ro.
 *   - Cuesta 36 no-shows en 21 días, casi 2 horarios quemados por día con la agenda llena.
 *
 * POR QUÉ HACEN FALTA CAMPOS (y el de 30 min no los necesita): una regla de Zoho puede
 * dispararse "X Antes De" la reunión, pero al crear una regla nueva las únicas unidades que
 * ofrece son días, semanas, meses y años. Horas NO (medido el 23-sep-2026; la regla vieja
 * `Recordatorio 30 min` dice "30 Minutos Antes De" porque se creó cuando la interfaz sí lo
 * permitía). Así que la hora se calcula acá y se escribe en un campo, y la regla se dispara
 * por ese campo. Mismo truco que el Sí/No.
 *
 * El de 4 h además pasa por `sinMadrugada` (nada antes de las 7 AM DEL CLIENTE): 4 h antes de
 * una reunión de las 9:30 serían las 5:30. El de 3 h no lo necesita, son 3 h exactas.
 * 4 h y no 3 para el de agenda llena: con 3 se pegaba al recordatorio de 30 min.
 */
import { get } from './zoho.js';
import { sinMadrugada } from './agendar-recordatorios.js';
import { programarTercerAviso, programarRecordatorio3h } from './escritura.js';

const TZ_DEFECTO = 'America/Argentina/Buenos_Aires';
const HORAS_AGENDA_LLENA = 4;
const HORAS_RECORDATORIO = 3;
const CAMPOS =
  'id,Event_Title,Start_DateTime,Confirmaci_n,Status_del_Meet,Tipo_de_reuni_n,Hora_de_confirmaci_n,Hora_tercer_aviso,Hora_recordatorio_3h,Zona_horaria_del_cliente,What_Id,Who_Id';

const isoZoho = (d) => d.toISOString().slice(0, 19) + '+00:00';
const cerrada = (e) => /^\[(CANCELADA|REAGENDADA)\]/.test(e.Event_Title || '');

/** Reuniones de venta de las próximas 24 h que siguen en juego. 1 llamada. */
export async function proximas(ahora = new Date()) {
  const hasta = new Date(ahora.getTime() + 24 * 36e5);
  const criterio = `((Start_DateTime:greater_than:${isoZoho(ahora)})and(Start_DateTime:less_equal:${isoZoho(hasta)}))`;
  const j = await get(`Events/search?criteria=${encodeURIComponent(criterio)}&fields=${CAMPOS}&per_page=200`);
  return (j.data || []).filter(
    (e) =>
      e.Tipo_de_reuni_n !== 'Clientes' &&
      e.What_Id?.id &&
      !cerrada(e) &&
      !e.Status_del_Meet &&
      // Solo a quien SÍ le preguntamos. Una reunión reservada con pocas horas de
      // anticipación no tiene Sí/No: mandarle "avisanos si no venís" sin haberle
      // preguntado antes es empezar la conversación por el final.
      e.Hora_de_confirmaci_n
  );
}

/** Una pasada. Con escribir=false solo calcula. */
export async function unaPasada({ escribir = false, ahora = new Date() } = {}) {
  const lista = await proximas(ahora);
  const r = { vistas: lista.length, agendaLlena: [], recordatorio: [], sinEntrar: [], fallidas: [] };
  const margen = new Date(ahora.getTime() + 2 * 60e3);

  for (const e of lista) {
    const tz = e.Zona_horaria_del_cliente || TZ_DEFECTO;
    const inicio = new Date(e.Start_DateTime).getTime();
    const mudo = !e.Confirmaci_n;
    const confirmo = e.Confirmaci_n === 'Confirmó';

    // El que dijo que no asiste no recibe nada: su hueco ya se libera solo (cancelaciones.js).
    if (!mudo && !confirmo) continue;
    // Ya programado en una pasada anterior.
    if (mudo ? e.Hora_tercer_aviso : e.Hora_recordatorio_3h) continue;

    const horas = mudo ? HORAS_AGENDA_LLENA : HORAS_RECORDATORIO;
    // Los DOS pasan por el filtro de madrugada (nada antes de las 7 AM del cliente). Crei
    // que el de 3 h no hacia falta y el ensayo del 23-sep lo desmintio: a Osvaldo (reunion
    // 9:00) le caia 5 de la manana, porque su huso esta detras del nuestro.
    const cuando = sinMadrugada(new Date(inicio - horas * 36e5), tz);

    // Si la ventana ya pasó no se manda: a esa altura el recordatorio de 30 min está por
    // salir y el hueco ya no se revende.
    if (cuando <= margen) {
      r.sinEntrar.push({ evento: e, motivo: `la ventana de ${horas} h ya pasó` });
      continue;
    }

    const fila = { evento: e, cuando, tz, tipo: mudo ? 'agenda llena' : 'recordatorio' };
    if (escribir) {
      const w = mudo ? await programarTercerAviso(e.id, cuando) : await programarRecordatorio3h(e.id, cuando);
      if (!w.ok) {
        r.fallidas.push({ ...fila, error: w.error || `quedo ${w.quedo}` });
        continue;
      }
    }
    (mudo ? r.agendaLlena : r.recordatorio).push(fila);
  }
  return r;
}
