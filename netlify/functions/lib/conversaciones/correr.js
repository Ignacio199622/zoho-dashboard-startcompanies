// Una pasada completa: leer, filtrar, clasificar, decidir, avisar.
import { conversacionesDesde, fichas } from './zoho.js';
import { pendientes, decidir } from './reglas.js';
import { clasificar } from './clasificar.js';
import { enviar, enviarResumenTope, avisarVentaAbierta, avisarVentaCerrada } from './slack.js';
import * as estadoFs from './estado.js';
import * as aprendizaje from './aprendizaje.js';
import * as seguimiento from './seguimiento.js';
import * as salientes from './salientes.js';
import {
  HORAS_PRIMERA_CORRIDA,
  MINUTOS_SOLAPE,
  MAX_ALERTAS_POR_CORRIDA,
  PRECIO,
  HAY_SLACK,
} from './config.js';

// `avisar`    manda a Slack de verdad.
// `registrar` avanza el corte y marca lo ya visto, aunque no se haya avisado.
//             Es lo que permite que la Fase 0 corra sola sin repetir cada caso
//             en cada pasada.
export async function unaPasada({
  avisar = HAY_SLACK,
  registrar = avisar,
  ahora = new Date(),
  desdeHoras = null,
} = {}) {
  const estado = estadoFs.leer();

  // Desde donde leer. El solape evita perder un registro que entro con unos
  // segundos de retraso respecto del corte anterior.
  const desde = desdeHoras
    ? new Date(ahora.getTime() - desdeHoras * 3600 * 1000)
    : estado.ultimoCorte
      ? new Date(new Date(estado.ultimoCorte).getTime() - MINUTOS_SOLAPE * 60 * 1000)
      : new Date(ahora.getTime() - HORAS_PRIMERA_CORRIDA * 3600 * 1000);

  const conversaciones = await conversacionesDesde(desde);

  // Antes de cualquier otra cosa: de las que estabamos siguiendo, cuales ya
  // contesto alguien del equipo. Ese par es el material de aprendizaje.
  const aprendidos = aprendizaje.capturar(conversaciones, estado, ahora);

  // Filtro sin costo: solo las que estan esperando al equipo.
  const esperando = pendientes(conversaciones, ahora);

  // Seguimiento: una conversacion que ya se aviso y sigue sin respuesta vuelve a
  // sonar a las 4h y a las 24h del primer aviso. La que todavia no cumplio el
  // plazo se saltea aca, antes de gastar un token en clasificarla de nuevo.
  const nuevas = [];
  for (const c of esperando) {
    const paso = estadoFs.quePasaCon(estado, c.id, c.message_time__s, ahora);
    if (paso.accion === 'callar') continue;
    nuevas.push({ ...c, seguimiento: paso });
  }

  // Quien es cada uno. Una llamada por modulo, no una por persona.
  const mapa = await fichas(nuevas.map((c) => c.sender__s));
  for (const c of nuevas) {
    const s = c.sender__s;
    c.ficha = s ? mapa[`${s.module?.api_name}:${s.id}`] : null;
  }

  const { porRef, uso } = await clasificar(nuevas);
  for (const c of nuevas) c.clase = porRef[c.ref];

  const alertas = [];
  const descartadas = [];
  for (const c of nuevas) {
    const clase = c.clase;
    const decision = decidir(c, clase, ahora);
    const fila = { ...c, clase, decision };
    if (decision.avisar) alertas.push(fila);
    else descartadas.push(fila);
  }

  alertas.sort(
    (a, b) =>
      b.decision.prioridad - a.decision.prioridad ||
      (b.seguimiento?.numero || 0) - (a.seguimiento?.numero || 0) ||
      b.minutosEsperando - a.minutosEsperando
  );

  const topeado = alertas.length > MAX_ALERTAS_POR_CORRIDA;
  const aEnviar = alertas.slice(0, MAX_ALERTAS_POR_CORRIDA);



  // El corte avanza solo cuando la corrida cuenta. Una consulta suelta
  // (`sombra.js`) no debe "comerse" mensajes que nadie llego a ver.
  if (registrar) {
    // Todo lo que sigue esperando queda anotado para poder cerrar el par cuando
    // alguien conteste. Se anotan todas, no solo las alertadas: como contesta el
    // equipo un caso menor tambien enseña.
    for (const c of nuevas) aprendizaje.anotarPendiente(estado, c);
    aprendizaje.podarPendientes(estado);
    for (const a of aEnviar) {
      estadoFs.marcar(estado, a.id, a.message_time__s, a.seguimiento?.accion === 'recordar', ahora);
      // Si es una venta, ademas queda en seguimiento y no se suelta aunque el
      // equipo conteste.
      seguimiento.abrir(estado, a, ahora);
    }
    estado.ultimoCorte = ahora.toISOString();
    estadoFs.podar(estado);
    // OJO: el guardado NO va aca. Abajo todavia se revisan las respuestas
    // salientes y los seguimientos, y eso tambien toca el estado. Guardar aca
    // hacia que todo lo de abajo se perdiera en silencio.
  }

  // Las ventas abiertas van por un carril aparte: no dependen de que el cliente
  // haya escrito, sino de que la venta siga sin cerrarse.
  // El punto ciego: conversaciones que el equipo contesto antes de que pasara el
  // agente. Nunca estuvieron "esperando" para el, asi que si no se miraran las
  // respuestas salientes se perderian. Medido: el 82% se contesta en menos de
  // una hora, o sea la mayoria.
  let hallazgosSalientes = { hallazgos: [], uso: { entrada: 0, salida: 0 }, miradas: 0 };
  if (registrar) {
    hallazgosSalientes = await salientes.revisar(conversaciones, estado);
    for (const h of hallazgosSalientes.hallazgos) {
      h.ficha = null;
      const s = h.sender__s;
      if (s) {
        const m = await fichas([s]);
        h.ficha = m[`${s.module?.api_name}:${s.id}`] || null;
      }
      seguimiento.abrir(estado, h, ahora);
    }
    salientes.podar(estado);
  }

  // El seguimiento necesita la clasificacion para poder cerrar por desinteres,
  // asi que se le pasan las conversaciones con la clase pegada donde la haya.
  const clasePorId = Object.fromEntries(nuevas.filter((c) => c.clase).map((c) => [c.id, c.clase]));
  const conClase = conversaciones.map((c) => (clasePorId[c.id] ? { ...c, clase: clasePorId[c.id] } : c));

  const { cerradas, aInsistir } = await seguimiento.revisar(estado, conClase, ahora);

  // Una alerta por caso: cada una se puede tomar, comentar y resolver aparte.
  // El panorama de cada 2 horas es otra cosa y va en `src/panorama.js`.
  if (avisar) {
    for (const a of aEnviar) await enviar(a);
    for (const v of cerradas) await avisarVentaCerrada(v);
    for (const v of aInsistir) await avisarVentaAbierta(v);
    if (topeado) await enviarResumenTope(alertas.length, MAX_ALERTAS_POR_CORRIDA);
  }

  // Ahora si: una sola escritura, con todo lo que la pasada dejo.
  if (registrar) estadoFs.guardar(estado);

  const costo =
    ((uso.entrada + hallazgosSalientes.uso.entrada) / 1e6) * PRECIO.entrada +
    ((uso.salida + hallazgosSalientes.uso.salida) / 1e6) * PRECIO.salida;

  return {
    desde,
    leidas: conversaciones.length,
    pendientes: esperando.length,
    alertas: aEnviar,
    todasLasAlertas: alertas,
    descartadas,
    uso,
    costo,
    avisado: avisar,
    aprendidos,
    ejemplosEnUso: aprendizaje.ejemplos().length,
    ventasCerradas: cerradas,
    ventasInsistidas: aInsistir,
    ventasAbiertas: seguimiento.abiertas(estado).length,
    salientesMiradas: hallazgosSalientes.miradas,
    salientesNuevas: hallazgosSalientes.hallazgos.length,
  };
}
