// EL "NO" NO MUERE EN EL LINK.
//
// Cuando el cliente toca "No" en el Si/No de 24 h, Zoho ya hace dos cosas (regla
// `SC Respuesta confirmacion reunion`): le manda "liberamos ese horario, elegi
// otro" y pinta la reunion de rojo. Y ahi se terminaba: nadie lo perseguia.
// Ignacio (20-sep-2026): "cuando dicen que no va a asistir tendria que entrar
// el seguimiento directo". Pero NO la cadencia de No Show, porque esos textos
// dicen "vi que no llegamos a conectar hoy": a alguien que aviso dos dias antes
// le suenan a mensaje de otra persona, y ademas lo contarian como no-show.
//
// Entonces, para cada reunion de venta con Confirmacion = "No asiste":
//
//   1. NO se toca el Estatus: lo gobierna el blueprint "status Meeting" y la API
//      lo rebota (RECORD_IN_BLUEPRINT, medido 20-sep-2026 con Nicolas). La marca
//      de "aviso que no viene" es Confirmacion = No asiste (+ rojo en el
//      calendario); las metricas distinguen por ese campo. Si alguien le pone
//      Asistio / No asistio a mano, la reunion deja de ser nuestra.
//   2. A las 24 h del "No", si no reservo de nuevo: "¿pudiste encontrar otro
//      horario?" con boton Agendar. Lo manda Zoho por la regla `Cancelacion
//      reagendar` (por fecha, Hora_de_recordatorio, Confirmacion = No asiste);
//      este modulo solo escribe la hora, igual que con el Si/No.
//   0. Se cancela la reserva en Cal, apenas se ve el "No". Es lo unico que libera el
//      hueco de verdad: borrar el evento de Google deja el agujero en el calendario
//      pero Cal sigue sin ofrecerlo (medido el 22 y 23-sep-2026, ver cal.js). Queda
//      marcada con Status_del_Meet = 'Cancelada' para que el [CANCELADA] que le pone
//      el Flow de Cal no la saque de este mismo seguimiento.
//   3. A las 72 h, si sigue sin reservar Y la reunion ya paso: se marca
//      Status_del_Meet = "No asistio" y la levanta lib/matias-noshow.js, que le
//      ofrece horarios y le reserva (3 toques y cierra). Hasta el 22-sep-2026 este
//      paso mandaba el lead a Retargeting; se cambio porque al borrar el evento de
//      Google para liberar el hueco, la reunion desaparece del calendario de Santi
//      y el "No asistio" ya no se lo pone nadie. Retargeting queda para cuando la
//      cadencia de no-show se rinde, no antes (las dos juntas le escribirian al
//      mismo lead: `pasadaNoShow()` no filtra por Lead_Status).
//   4. Si en cualquier momento reserva de nuevo (Cal crea otra reunion futura),
//      no se hace nada mas.
//
// No guarda estado propio: cada paso deja su marca en el CRM (Estatus,
// Hora_de_recordatorio posterior al "No", Lead_Status) y la pasada siguiente la
// lee. La hora del "No" sale del timeline de la reunion (1 llamada por
// cancelada; son pocas).
import { get } from './zoho.js';
import { sinMadrugada } from './agendar-recordatorios.js';
import { programarRecordatorioCancelacion, marcarNoShow, marcarCancelada, ESTADOS_YA_FUERA } from './escritura.js';
import { reservaViva, cancelarReserva } from './cal.js';


export const HORAS_RECORDATORIO = 24;
export const HORAS_RETARGETING = 48;
const DIAS_ATRAS = 10;
const DIAS_ADELANTE = 30;
const TZ_DEFECTO = 'America/Argentina/Buenos_Aires';
const CAMPOS =
  'id,Event_Title,Start_DateTime,Created_Time,Confirmaci_n,Status_del_Meet,Tipo_de_reuni_n,What_Id,Who_Id,Zona_horaria_del_cliente,Hora_de_recordatorio,Hora_local_del_cliente';
// Los que ya salieron de la venta por otro lado: no se los toca.
const ESTADOS_QUE_FRENAN = [...ESTADOS_YA_FUERA, 'Retargeting', 'Convertido', 'Cliente', 'No Show'];

const isoZoho = (d) => d.toISOString().slice(0, 19) + '+00:00';
const cerrada = (e) => /^\[(CANCELADA|REAGENDADA)\]/.test(e.Event_Title || '');
// Cuando NOSOTROS cancelamos en Cal para liberar el hueco, el Flow le pone [CANCELADA] al
// titulo igual que a una cancelacion del cliente. Sin distinguirlas, liberar el hueco
// apagaba el seguimiento entero. La marca propia es Status_del_Meet = 'Cancelada'.
const nuestra = (e) => e.Status_del_Meet === 'Cancelada';
// [REAGENDADA] siempre queda afuera: ya hay otra reunion. [CANCELADA] solo si no es nuestra.
const fueraDeJuego = (e) => /^\[REAGENDADA\]/.test(e.Event_Title || '') || (/^\[CANCELADA\]/.test(e.Event_Title || '') && !nuestra(e));

/** Reuniones de venta con "No asiste" (colgadas de un lead), de -10 a +30 dias. 1 llamada. */
export async function canceladas(ahora = new Date()) {
  const desde = new Date(ahora.getTime() - DIAS_ATRAS * 86400e3);
  const hasta = new Date(ahora.getTime() + DIAS_ADELANTE * 86400e3);
  const criterio = `((Confirmaci_n:equals:No asiste)and(Start_DateTime:greater_than:${isoZoho(desde)})and(Start_DateTime:less_equal:${isoZoho(hasta)}))`;
  const out = [];
  for (let page = 1; page <= 3; page++) {
    const j = await get(`Events/search?criteria=${encodeURIComponent(criterio)}&fields=${CAMPOS}&per_page=200&page=${page}`);
    out.push(...(j.data || []));
    if (!j.info?.more_records) break;
  }
  return out.filter((e) => e.Tipo_de_reuni_n !== 'Clientes' && e.What_Id?.id && !fueraDeJuego(e));
}

/**
 * Las marcas del "No" en el timeline: cuando dijo que no (cambio de Confirmacion) y si
 * DESPUES de eso se reescribio Hora_de_recordatorio (o sea, el paso 2 ya se programo).
 * El valor del campo solo no alcanza: la hora original del "recorda responder" tambien
 * puede caer despues del No (Mara, 17-sep-2026), y eso saltearia el recordatorio.
 */
export async function marcasDelNo(eventId) {
  const t = await get(`Events/${eventId}/__timeline?per_page=60`);
  const lista = t.__timeline || [];
  const cambio = (a, campo, valor) => (a.field_history || []).some((f) => f.api_name === campo && (valor === void 0 || f._value?.new === valor));
  const no = lista.find((a) => cambio(a, "Confirmaci_n", "No asiste"));
  if (!no) return { dijoNo: null, recordadoDespues: false };
  const dijoNo = new Date(no.audited_time);
  const recordadoDespues = lista.some((a) => new Date(a.audited_time) > dijoNo && cambio(a, "Hora_de_recordatorio"));
  return { dijoNo, recordadoDespues };
}

/** ¿Reservo otra reunion despues del "No"? Una futura, viva, creada despues de esa hora. 1 llamada. */
export async function reservoDeNuevo(leadId, despues, ahora = new Date()) {
  const criterio = `((What_Id:equals:${leadId})and(Start_DateTime:greater_than:${isoZoho(ahora)}))`;
  const j = await get(`Events/search?criteria=${encodeURIComponent(criterio)}&fields=id,Event_Title,Start_DateTime,Created_Time,Confirmaci_n,Status_del_Meet&per_page=50`).catch(() => ({}));
  return (
    (j.data || []).find(
      (e) => !cerrada(e) && e.Confirmaci_n !== 'No asiste' && e.Status_del_Meet !== 'Cancelada' && new Date(e.Created_Time) > despues
    ) || null
  );
}

/**
 * Una pasada. Con escribir=false solo cuenta lo que haria. `horas` acorta los plazos
 * para probar con una reunion real sin esperar un dia; `solo` limita a una reunion.
 */
export async function unaPasada({
  escribir = false,
  ahora = /* @__PURE__ */ new Date(),
  horas = { recordatorio: HORAS_RECORDATORIO, retargeting: HORAS_RETARGETING },
  solo = null
} = {}) {
  const lista = (await canceladas(ahora)).filter((e) => !solo || e.id === solo);
  const r = { vistas: lista.length, liberadas: [], recordadas: [], noShow: [], reservaron: [], esperando: [], fallidas: [] };
  const H2 = 36e5;
  for (const e of lista) {
    const fila = { evento: e };
    try {
      const { dijoNo, recordadoDespues } = await marcasDelNo(e.id);
      if (!dijoNo) {
        r.esperando.push({ ...fila, motivo: "sin fecha del No en el timeline" });
        continue;
      }
      fila.dijoNo = dijoNo;
      const tz = e.Zona_horaria_del_cliente || TZ_DEFECTO;
      if (e.Status_del_Meet && e.Status_del_Meet !== "Cancelada") {
        r.esperando.push({ ...fila, motivo: `estatus ${e.Status_del_Meet}` });
        continue;
      }
      if (!nuestra(e) && new Date(e.Start_DateTime) > ahora) {
        const reserva = await reservaViva(e.Start_DateTime, e).catch((err) => {
          fila.avisoCal = err.message;
          return null;
        });
        if (reserva) {
          if (escribir) {
            const c = await cancelarReserva(reserva.uid, "El cliente avis\xF3 que no puede asistir", reserva._cuenta);
            if (!c.ok) {
              r.fallidas.push({ ...fila, paso: "liberar hueco", error: c.error });
              continue;
            }
            const m = await marcarCancelada(e.id);
            if (!m.ok) {
              r.fallidas.push({ ...fila, paso: "marcar Cancelada", error: m.error || `quedo ${m.quedo}` });
              continue;
            }
          }
          r.liberadas.push({ ...fila, uid: reserva.uid, cuando: e.Start_DateTime });
          continue;
        }
      }
      const nueva = await reservoDeNuevo(e.What_Id.id, dijoNo, ahora);
      if (nueva) {
        r.reservaron.push({ ...fila, nueva });
        continue;
      }
      const pasaron = (ahora - dijoNo) / H2;
      const yaRecordado = recordadoDespues;
      if (!yaRecordado && pasaron >= horas.recordatorio) {
        const cuando2 = sinMadrugada(new Date(ahora.getTime() + 3 * 6e4), tz);
        if (escribir) {
          const w = await programarRecordatorioCancelacion(e.id, cuando2);
          if (!w.ok) {
            r.fallidas.push({ ...fila, paso: "recordatorio", error: w.error || `quedo ${w.quedo}` });
            continue;
          }
        }
        r.recordadas.push({ ...fila, cuando: cuando2, tz });
        continue;
      }
      if (pasaron >= horas.retargeting) {
        if (new Date(e.Start_DateTime) >= ahora) {
          r.esperando.push({ ...fila, motivo: "la reunion todavia no paso" });
          continue;
        }
        const l = (await get(`Leads/${e.What_Id.id}?fields=Lead_Status,Retargeting,Full_Name`)).data?.[0];
        if (!l) {
          r.esperando.push({ ...fila, motivo: "lead no encontrado (convertido?)" });
          continue;
        }
        if (ESTADOS_QUE_FRENAN.includes(l.Lead_Status) || l.Retargeting) {
          r.esperando.push({ ...fila, motivo: `lead ya en ${l.Lead_Status}${l.Retargeting ? " (retargeting)" : ""}` });
          continue;
        }
        if (escribir) {
          const w = await marcarNoShow(e.id);
          if (!w.ok) {
            r.fallidas.push({ ...fila, paso: "no-show", error: w.error || `quedo ${w.quedo}` });
            continue;
          }
          fila.quedo = w.quedo;
        }
        r.noShow.push({ ...fila, lead: l });
        continue;
      }
      r.esperando.push({ ...fila, motivo: `${Math.round(pasaron)} h desde el No${yaRecordado ? ", ya recordado" : ""}` });
    } catch (err) {
      r.fallidas.push({ ...fila, paso: "?", error: err.message });
    }
  }
  return r;
}
