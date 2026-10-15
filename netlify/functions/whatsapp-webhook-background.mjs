/*
 * El trabajo del timbre: leer el mensaje que acaba de entrar y contestarlo.
 *
 * Corre en background porque puede tardar (consulta a Gemini y dos llamadas a
 * Zoho) y Meta no espera. Quien lo dispara es `whatsapp-webhook.mjs`, que ya
 * contesto 200.
 *
 * ─── EL ORDEN, DE LO BARATO A LO CARO ──────────────────────────────────────
 *
 *   1. ¿Es un mensaje de texto entrante? Los cambios de estado (entregado,
 *      leido) tambien llegan acá y no hay nada que hacer con ellos.
 *   2. Los frenos deterministicos. No cuestan un token.
 *   3. ¿Es cliente? Se busca el contacto por telefono. Si no aparece, es un
 *      lead y hoy el bot no le contesta (decision de Ignacio: solo clientes).
 *   4. ¿Ya le contestamos hace poco? Un mensaje por conversacion cada 12 h.
 *   5. Recien ahi el modelo elige una de las 40 respuestas.
 *   6. Se escribe el texto y se tilda la casilla. Zoho manda.
 *
 * ─── LA RAFAGA ─────────────────────────────────────────────────────────────
 *
 * La gente manda dos o tres mensajes seguidos mientras piensa. Sin freno, cada
 * uno dispararia una respuesta. El candado del punto 4 lo cubre: el primero
 * contesta y los que vienen atras se saltean.
 */
import { getStore } from '@netlify/blobs';
import { freno, elegir, decidirRespuesta } from './lib/conversaciones/responder.js';
import { generar } from './lib/conversaciones/gemini.js';
import { MODELO_GEMINI } from './lib/conversaciones/config.js';
import { estaAbierto } from './lib/conversaciones/guardia.js';
import { contactosConTelefono, marcarRespuestaAutomatica, limpiarRespuestaAutomatica, leadsConTelefono }
  from './lib/conversaciones/escritura.js';
import { aplanar } from './lib/conversaciones/enviar-zoho.js';
import { avisar } from './lib/aviso-marcos.js';
import { avisarFalla } from './lib/aviso-falla.js';
import * as hilo from './lib/hilo.js';
import { registrarPregunta } from './lib/marcos-aprende.js';
import * as matias from './lib/matias.js';
import * as controlContacto from './lib/control-contacto.js';
import { despedidaDe, esSondeo, avisoSeguridad } from './lib/matias-cerebro.js';
// Cualquier forma de "no me interesa" cierra la ficha con despedida (los "basta" y
// "no me escribas" los sigue frenando el cerebro, sin despedida: ahí mejor callarse).
const DICE_NO = /\b(no (me|le|nos) interesa|no estoy interesad|ya no (me )?interesa|fue un error|n[aã]o tenho interesse)\b/i;
import { candadoCliente } from './lib/matias-cliente.js';
import * as portal from './lib/portal.js';
import { proponer, origenDe, LINKS, registroDe, TEXTOS, textoDe, nombreDe } from './lib/matias-cerebro.js';
import { aplicarAccion, contextoDeHoy, describir, mailEn } from './lib/matias-agenda.js';

const ENVIAR = process.env.RESPUESTAS_ENVIAR === '1';
const TOPE_DIA = Number(process.env.RESPUESTAS_TOPE_DIA || 5);
const HORAS_ENTRE_RESPUESTAS = 12;
// Cuanto se le da a la regla de Zoho para que dispare antes de destildar.
const ESPERA_ANTES_DE_DESTILDAR = 8000;

/** Saca los mensajes de texto entrantes del cuerpo que manda Meta. */
function mensajesEntrantes(cuerpo) {
  const out = [];
  for (const entrada of cuerpo?.entry || []) {
    for (const cambio of entrada.changes || []) {
      const v = cambio.value || {};
      // `statuses` son acuses (entregado, leido). No son mensajes.
      for (const m of v.messages || []) {
        // Los botones de respuesta rápida de una plantilla llegan como `button`
        // (Matías, 18-sep: Quiero agendar / No me interesa); los de un mensaje
        // interactivo, como `interactive.button_reply`. Los dos se tratan como
        // texto, y `boton` dice qué eligió.
        let texto = m.type === 'text' ? m.text?.body : null;
        let boton = null;
        if (m.type === 'button' && m.button?.text) texto = m.button.text;
        if (m.type === 'interactive' && m.interactive?.button_reply?.title) texto = m.interactive.button_reply.title;
        if (!texto) continue;
        if (m.type !== 'text') boton = /no me interesa|n[aã]o tenho interesse/i.test(texto) ? 'baja' : /agendar/i.test(texto) ? 'agendar' : 'otro';
        out.push({
          de: m.from,
          texto,
          boton,
          id: m.id,
          cuando: m.timestamp ? new Date(Number(m.timestamp) * 1000) : new Date(),
          nombre: (v.contacts || []).find((c) => c.wa_id === m.from)?.profile?.name || '',
          referral: m.referral || null, // click-to-WhatsApp: el anuncio del que vino
        });
      }
    }
  }
  return out;
}

// Matias propone (sombra) o contesta (MATIAS_ENVIAR=1). Nunca rompe el
// registro: si Gemini o Meta fallan, el mensaje ya quedo en Slack y en Zoho.
const MATIAS_ENVIA = process.env.MATIAS_ENVIAR === '1';
// Cuánto se espera a que termine la ráfaga antes de contestar (ver responderComoMatias).
// Desde el 18-sep es un rato humano: entre 15 y 35 s al azar (Ignacio: "lo más humano
// posible"; nadie contesta un WhatsApp en 2 segundos). MATIAS_ESPERA_RAFAGA_MS lo fija.
const esperaRafaga = () => Number(process.env.MATIAS_ESPERA_RAFAGA_MS) || 15000 + Math.floor(Math.random() * 20000);
async function llegoOtroDespues(numero, ahora) {
  await new Promise((r) => setTimeout(r, esperaRafaga()));
  const h = await hilo.leer(numero, new Date());
  return h.some((x) => x.de === 'cliente' && new Date(x.cuando).getTime() > ahora.getTime());
}
/**
 * Exportada para que `matias-empujar-background` pueda RETOMAR un mensaje del
 * lead que quedó sin contestar (Deavy, 16-sep: eligió horario y Gemini se cortó).
 */
export async function responderComoMatias(m, lead, ahora) {
  try {
    // ─── LA RÁFAGA ─────────────────────────────────────────────────────────
    // "A la tarde" y "No me acuerdo" con 2 segundos de diferencia (Anabela,
    // 17-sep): Meta manda un webhook por mensaje, cada uno levanta su propio
    // worker y los dos contestaron lo mismo. Se espera un momento y, si el lead
    // mandó otro mensaje después de este, se calla: el worker del último
    // contesta una sola vez con toda la ráfaga como contexto.
    if (await llegoOtroDespues(m.de, ahora)) {
      console.log(`matias no contesta "${m.texto.slice(0, 40)}": llegó otro mensaje del lead después`);
      return;
    }
    // Ya lo leyó y está escribiendo (tildes azules + "escribiendo…"), antes de pensar.
    if (MATIAS_ENVIA) await matias.leidoYEscribiendo(m.de, m.id);
    const previos = (await hilo.leer(m.de, ahora)).filter((h) => h.texto !== m.texto);
    const estado = await matias.estadoDe(m.de);
    // El mail del lead (28-sep): se saca del chat con código y se guarda en la ficha
    // apenas lo escribe. Antes solo lo podía pasar el modelo (casi nunca lo hacía) y
    // vivía en el hilo, que vence a las 12 h: M&K y Poncho lo mandaron 3 veces y
    // Matías lo siguió pidiendo; al otro día decía "no me figura en el chat".
    const mailDelChat = mailEn(m.texto) || [...previos].reverse().filter((h) => h.de === 'cliente').map((h) => mailEn(h.texto)).find(Boolean) || '';
    if (mailDelChat && mailDelChat !== estado.email) {
      estado.email = mailDelChat;
      await matias.marcarEvento(m.de, { email: mailDelChat }, ahora);
    }
    if (estado.email && !lead?.Email) lead = { ...(lead || {}), Email: estado.email };
    // La apertura sale por cron y no pasa por el hilo, y el hilo vence a las 12 h: el
    // que contestaba al día siguiente llegaba al cerebro como "Todavía no hablaron" y
    // Matías se presentaba de nuevo (Anabela, 17-sep) o inventaba una oferta de
    // horarios ante un "Sii claro" (Brian). Se repone la apertura como primer mensaje.
    if (!previos.some((h) => h.de === 'nosotros') && estado.enviada && estado.plantilla) {
      const clave = estado.origen === 'ctwa' ? 'meta' : estado.origen;
      if (TEXTOS[clave]) {
        previos.unshift({ de: 'nosotros', texto: `(mensaje de apertura, enviado el ${String(estado.enviada).slice(0, 10)}) ${textoDe(clave, estado.plantilla, nombreDe(lead, estado))}`, cuando: estado.enviada });
      }
    }
    // Una persona tomó el hilo desde el portal: Matías se calla hasta que lo devuelvan.
    if (estado.humano || (await portal.loTomoUnaPersona(m.de))) {
      await matias.enHilo(m.de, `🙋 Matías no contesta: _lo tiene ${estado.humanoQuien || 'alguien del equipo'} en el portal_`);
      console.log('matias no contesta (humano en el portal)');
      return;
    }
    if (!(await matias.esMiTurno(m.de, m.id))) { console.log('matias no contesta: llegó otro mensaje del lead (turno)'); return; }
    // Matías ya reservó el horario y solo faltaba el mail: llegó, se reserva sin
    // pasar por el modelo (que era justo el que lo perdía).
    const soloFaltabaMail = Boolean(estado.pendienteMail && mailEn(m.texto));
    const p = soloFaltabaMail
      ? { responde: true, texto: '', motivo: '', frenado: false, accion: { tipo: 'reservar', inicio: estado.pendienteMail, email: estado.email } }
      : await proponer({ lead, numero: m.de, hilo: previos, ultimo: m.texto, hoy: contextoDeHoy(m.de, ahora), estado });
    if (!p.responde) {
      if (/no le escriban/.test(p.motivo)) await matias.cerrarApertura(m.de, 'pidió que no le escriban', ahora);
      else if (/no (est[aá] |le |se )?interes|despedida|no quiere|cerrad[ao]/i.test(p.motivo)) await matias.cerrarApertura(m.de, 'no le interesa', ahora);
      else if (p.frenado) await matias.marcarEvento(m.de, { frenado: p.motivo, frenadoEl: ahora.toISOString() }, ahora);
      await matias.enHilo(m.de, `🛑 Matías no contesta: _${p.motivo}_${p.frenado ? ' · *lo toma una persona*' : ''}`);
      console.log(`matias no contesta (${p.motivo})`);
      return;
    }
    // ─── LA AGENDA: Matías ofrece horarios reales y reserva él ───────────────
    // El cerebro pide la acción; `aplicarAccion` lee Cal.com en la hora del lead y,
    // si eligió un horario ofrecido, crea la reserva. Si Cal falla, vuelve al link.
    let texto = p.texto;
    let agenda = {};
    // "Descartar": el lead no busca una LLC ni una cuenta (visa, empleo, trámites
    // personales). Matías se despide en una línea y la ficha se cierra: sin
    // seguimientos ni horarios (Ignacio, 15-sep: "que sea calificado").
    const descarta = p.accion?.tipo === 'descartar';
    // Antes de reservar o mandar: ¿sigue siendo mi turno? (ver tomarTurno en matias.js)
    if (!(await matias.esMiTurno(m.de, m.id))) { console.log('matias no contesta: otro mensaje del lead tomó el turno'); return; }
    if (!descarta && p.accion?.tipo !== 'ninguna') {
      try {
        const origen = origenDe(lead);
        // Antes de mirar la agenda, avisa que la está mirando (Ignacio, 18-sep: "muy
        // humano"): una burbuja corta, y unos segundos después los horarios.
        if (MATIAS_ENVIA && p.accion.tipo === 'ofrecer_horarios') {
          const aviso = registroDe(m.de) === 'vos' ? 'Dale, dejame ver qué tengo libre.' : 'Vale, déjame ver qué tengo libre.';
          await matias.enviarTexto(m.de, aviso).catch(() => {});
          await hilo.agregar(m.de, 'nosotros', aviso, ahora);
          await new Promise((r) => setTimeout(r, 4000 + Math.floor(Math.random() * 4000)));
        }
        agenda = await aplicarAccion({ p, origen, lead, numero: m.de, estado, ahora });
        texto = agenda.texto;
        // Estaba molesto y se resolvió reservando: la confirmación fija va con la disculpa adelante.
        if (p.molesto && agenda.reservado) texto = `${registroDe(m.de) === 'vos' ? 'Tenés razón, perdón por hacerte repetirlo.' : 'Tienes razón, perdón por hacerte repetirlo.'} ${texto}`;
        if (agenda.sinHorarios) {
          texto = `Ahora mismo no me queda ningún horario libre para ese momento. ${registroDe(m.de) === 'vos' ? 'Podés' : 'Puedes'} elegir el que mejor te quede acá y queda reservado: ${LINKS[origen]}`;
          await matias.enHilo(m.de, 'ℹ️ Sin horarios libres en Cal para lo que pidió: Matías mandó el link.').catch(() => {});
        }
        if (agenda.ofrecidos?.length) await matias.marcarEvento(m.de, { ofrecidos: agenda.ofrecidos, pendienteMail: agenda.pendienteMail || null }, ahora);
        if (agenda.aviso) await matias.enHilo(m.de, `ℹ️ ${agenda.aviso}`);
      } catch (e) {
        console.error('agenda fallo:', e.message);
        await matias.enHilo(m.de, `⚠️ La agenda falló (${e.message}); Matías vuelve al link.`).catch(() => {});
        texto = `${p.texto || 'Dale.'} ${registroDe(m.de) === 'vos' ? 'Podés' : 'Puedes'} elegir el horario acá: ${LINKS[origenDe(lead)]}`;
      }
    }
    if (!texto) { await matias.enHilo(m.de, '🛑 Matías no contesta: _el cerebro devolvió texto vacío_'); return; }
    if (!MATIAS_ENVIA) {
      const citado = texto.split('\n').join('\n> ');
      await matias.enHilo(m.de, `💡 *Propuesta de Matías (sombra, no se mandó):*\n> ${citado}`);
      console.log('matias propuso (sombra)');
      return;
    }
    // Las respuestas van siempre escritas (Ignacio, 14-sep: "no quiero que vaya en
    // audio; solo cuando sea necesario un push"). La nota de voz vive en el
    // seguimiento (lib/matias-seguimiento.js).
    if (!(await matias.esMiTurno(m.de, m.id))) { console.log('matias no manda: otro mensaje del lead tomó el turno'); return; }
    if (matias.repite(texto, previos)) {
      await matias.enHilo(m.de, `🔁 Matías iba a repetir casi lo mismo que ya mandó y no lo mandó: _${texto.slice(0, 140)}_ · *contestale a mano*`);
      console.log('matias no manda: repetido');
      return;
    }
    await matias.enviarTexto(m.de, texto);
    await hilo.agregar(m.de, 'nosotros', texto, ahora);
    await matias.registrar({ numero: m.de, de: 'matias', texto, cuando: ahora });
    await matias.marcarEvento(m.de, { respondioMatias: ahora.toISOString() }, ahora);
    if (p.pideHumano) {
      await matias.marcarEvento(m.de, { frenado: 'preguntó si es una persona', frenadoEl: ahora.toISOString() }, ahora);
      await matias.enHilo(m.de, '🙋 *Preguntó si habla con una persona.* Matías le dijo que es la agenda automática y le ofreció una persona: si contesta que sí, tomalo desde el portal.');
    }
    if (p.molesto) {
      await matias.marcarEvento(m.de, { frenado: 'estaba molesto', frenadoEl: ahora.toISOString() }, ahora);
      await matias.enHilo(m.de, '😠 *Lead molesto.* Matías pidió disculpas y resolvió lo pendiente; el seguimiento automático queda frenado. Miralo.');
    }
    if (descarta) {
      await matias.cerrarApertura(m.de, `no califica (${p.motivo || 'no busca una LLC'})`, ahora);
      await matias.enHilo(m.de, `🚫 *No califica*: _${p.motivo || 'no busca una LLC'}_. Matías se despidió y no le escribe más.`);
    }
    if (agenda.reservado) {
      const r = agenda.reservado;
      await matias.marcarEvento(m.de, { reserva: { uid: r.uid, inicio: r.inicio, email: r.email, cuando: ahora.toISOString() }, pendienteMail: null }, ahora);
      await matias.cerrarApertura(m.de, 'agendó', ahora);
      await matias.enHilo(m.de, `🎯 *Matías reservó la reunión*: ${describir(r.inicio, r.tz)} (hora del lead) · ${r.email} · Cal ${r.uid}${r.meetingUrl ? ` · ${r.meetingUrl}` : ''}${r.cancelada ? `
↩️ La anterior (${r.cancelada}) se canceló en Cal; Zoho la marca sola.` : ''}`);
    }
    if (agenda.confirmado) {
      await matias.marcarEvento(m.de, { confirmo: { ...agenda.confirmado, cuando: ahora.toISOString() } }, ahora);
      await matias.cerrarApertura(m.de, 'confirmó la reunión', ahora);
      await matias.enHilo(m.de, `✅ *Confirmó con Matías* la asesoría del ${agenda.confirmado.cuando}. Quedó Confirmación = Confirmó en el CRM.`);
    }
    console.log('matias contesto');
  } catch (e) {
    console.error('matias fallo:', e.message);
    await matias.enHilo(m.de, `⚠️ Matías falló: ${e.message}`).catch(() => {});
  }
}

async function procesar(req) {
  const ahora = new Date();
  let cuerpo;
  try {
    cuerpo = await req.json();
  } catch {
    return new Response('cuerpo ilegible', { status: 200 });
  }

  // Los acuses de Meta (entregado, leído, fallado) del +52 van a la ficha del
  // lead. Los del 786 se siguen tirando: esa conversación vive en Zoho.
  for (const acuse of matias.acusesDeMatias(cuerpo)) {
    await matias.registrarAcuse(acuse, ahora).catch((e) => console.log(`acuse ${acuse.estado} no registrado: ${e.message}`));
  }

  const entrantes = mensajesEntrantes(cuerpo);
  if (!entrantes.length) return new Response('nada que hacer', { status: 200 });

  // ─── EL +52 ES DE MATIAS, NO DE MARCOS ────────────────────────────────────
  //
  // La app esta suscripta a dos cuentas de WhatsApp: la del 786 (Zoho) y la
  // del +52 (Matias). Los dos caen aca. Sin este desvio, un cliente que le
  // escribe al +52 recibiria la respuesta de Marcos... desde el 786. Se decide
  // por `metadata.phone_number_id`, que Meta manda en cada evento.
  if (matias.esDeMatias(cuerpo)) {
    // La línea por la que entró (el 863 o el +52) queda en la ficha: la respuesta
    // y todo lo que siga a este lead salen por esa misma línea.
    const linea = matias.lineaDelEvento(cuerpo);
    for (const m of entrantes) {
      // El WhatsApp de admin respondiendo un aviso de Panel gratis (control de contacto,
      // 14-oct): no es un lead, nunca lo atiende Matías. Se anota en Zoho y se confirma.
      if (controlContacto.esDelEquipo(m.de)) {
        await controlContacto.registrarRespuesta(m, linea).catch((e) => console.error('control-contacto fallo:', e.message));
        continue;
      }
      await matias.tomarTurno(m.de, m.id); // el último mensaje del lead es el que se contesta
      await hilo.agregar(m.de, 'cliente', m.texto, ahora);
      // El candado de cliente va ANTES de todo: si el que escribe ya es cliente
      // (por teléfono, en Contactos, Propietarios o la LLC), no se le crea un
      // lead, no se lo cadencia y no le contesta Matías. Se registra el mensaje
      // (Slack, portal, nota) y queda para el equipo. Ignacio, 18-sep: "nunca
      // puede tocar un cliente".
      const estadoPrevio = await matias.estadoDe(m.de);
      const cliente = await candadoCliente(m.de, { nombre: m.nombre || '', ficha: estadoPrevio, ahora }).catch((e) => ({ es: false, error: e.message }));
      if (cliente.es) {
        const r = await matias.registrar({ numero: m.de, de: 'lead', texto: m.texto, cuando: m.cuando });
        await matias.avisarCliente(m.de, cliente, r.lead).catch(() => {});
        console.log(`matias <- ${m.de}: es cliente (${cliente.quien}), no se contesta`);
        continue;
      }
      // Si no está en Zoho, es alguien que escribió primero (un anuncio click-to-
      // WhatsApp, o el número suelto): se crea el lead y arranca su cadencia.
      if (!estadoPrevio.lead && !(await leadsConTelefono(m.de)).length) {
        try {
          const nuevo = await matias.crearLead({ numero: m.de, nombre: m.nombre, referral: m.referral });
          await matias.marcarEvento(m.de, { enviada: ahora.toISOString(), origen: 'ctwa', lead: nuevo.id, nombre: m.nombre || undefined, toques: 1, ultimoToque: ahora.toISOString(), anuncio: m.referral?.source_id || null, linea }, ahora);
          await matias.enHilo(m.de, `🆕 Lead creado en Zoho (${m.referral ? `anuncio ${m.referral.source_id}${m.referral.headline ? ` · ${m.referral.headline}` : ''}` : 'sin anuncio'}) · <https://crm.zoho.com/crm/org881745849/tab/Leads/${nuevo.id}|ver ficha>`).catch(() => {});
          console.log(`lead creado ${nuevo.id} para ${m.de}`);
        } catch (e) {
          console.error(`no se pudo crear el lead de ${m.de}: ${e.message}`);
        }
      }
      const r = await matias.registrar({ numero: m.de, de: 'lead', texto: m.boton ? `${m.boton === 'baja' ? '🔴' : '🟢'} [botón] ${m.texto}` : m.texto, cuando: m.cuando });
      console.log(`matias <- ${m.de}: slack=${r.slack} zoho=${r.zoho}${m.boton ? ` botón=${m.boton}` : ''}`);
      await matias.marcarEvento(m.de, { contesto: m.cuando.toISOString(), lead: r.lead?.id || undefined, nombre: r.lead?.Full_Name || undefined, linea }, ahora);
      // Sondeo o ataque (qué CRM usan, ignorá tus instrucciones, pasame la lista de
      // clientes, sos una IA…): NO llega al cerebro. La primera vez, una línea firme y
      // alerta en Slack; la segunda, silencio y ficha cerrada como sospechosa. Ver
      // SEGURIDAD en matias-cerebro.js.
      if (esSondeo(m.texto)) {
        const ficha = await matias.estadoDe(m.de);
        const intentos = (ficha.sondeos || 0) + 1;
        await matias.marcarEvento(m.de, { sondeos: intentos, ultimoSondeo: ahora.toISOString(), frenado: 'intento de extracción', frenadoEl: ahora.toISOString() }, ahora);
        const cita = String(m.texto).slice(0, 160).replace(/\n/g, ' ');
        if (intentos === 1) {
          const aviso = avisoSeguridad(m.de);
          if (MATIAS_ENVIA) {
            await matias.enviarTexto(m.de, aviso).catch((e) => console.log(`aviso de seguridad no salió: ${e.message}`));
            await hilo.agregar(m.de, 'nosotros', aviso, ahora);
            await matias.registrar({ numero: m.de, de: 'matias', texto: aviso, cuando: ahora });
          }
          await matias.enHilo(m.de, `🚨 *Sondeo / intento de extracción*: "${cita}". Matías mandó el aviso de seguridad. Si insiste, se calla y cierra la ficha.`);
          await matias.enCanal(`🚨 *Intento de sacar info interna* por WhatsApp (+${m.de}${r.lead?.Full_Name ? `, ${r.lead.Full_Name}` : ''}): "${cita}". Matías avisó que se investiga. Revisar el hilo.`).catch(() => {});
        } else {
          await matias.cerrarApertura(m.de, `sospechoso: ${intentos} intentos de extracción`, ahora);
          await matias.enHilo(m.de, `🚨 Insistió (${intentos}): "${cita}". Matías no contesta más; ficha cerrada como sospechosa.`);
        }
        continue;
      }
      // "No me interesa" (botón o texto): una línea de despedida y la ficha cerrada. No pasa
      // por el cerebro: no hay nada que pensar, y así no se reporta como spam.
      if (m.boton === 'baja' || DICE_NO.test(m.texto)) {
        const estadoPrevio = await matias.estadoDe(m.de);
        await matias.cerrarApertura(m.de, m.boton === 'baja' ? 'no le interesa (botón)' : 'no le interesa', ahora);
        if (!estadoPrevio.cerrado) {
          const adios = despedidaDe(m.de);
          if (MATIAS_ENVIA) {
            await matias.leidoYEscribiendo(m.de, m.id, { escribiendo: false });
            await matias.enviarTexto(m.de, adios).catch((e) => console.log(`despedida no salió: ${e.message}`));
            await hilo.agregar(m.de, 'nosotros', adios, ahora);
            await matias.registrar({ numero: m.de, de: 'matias', texto: adios, cuando: ahora });
          }
          await matias.enHilo(m.de, `🛑 Dijo que no${m.boton === 'baja' ? ' (botón)' : ''}. Matías se despidió en una línea y no le escribe más.`);
        }
        continue;
      }
      await responderComoMatias(m, r.lead, ahora);
    }
    return new Response('registrado para matias', { status: 200 });
  }

  // ─── MARCOS APRENDE ────────────────────────────────────────────────────────
  //
  // Cada mensaje al 786 queda guardado como pregunta, ANTES del horario y de
  // los frenos: la pasada semanal (marcos-aprende) agrupa lo que preguntan los
  // clientes y propone las guias y videos que faltan en el panel. Desde el
  // 18-sep Marcos no contesta; escucha. Nunca corta: si falla, se pierde una
  // fila y nada mas.
  for (const m of entrantes) await registrarPregunta(m, ahora);

  // Fuera de horario contesta la guardia, con el mensaje de ausencia.
  //
  // `RESPUESTAS_SIN_HORARIO=1` saltea este freno. Es una puerta SOLO para
  // probar de noche: mientras este puesta, Marcos y la guardia le contestan los
  // dos al mismo cliente. Se pone, se prueba y se saca en el momento.
  const sinHorario = process.env.RESPUESTAS_SIN_HORARIO === '1';
  if (!estaAbierto(ahora) && !sinHorario) {
    console.log('fuera de horario: lo toma la guardia');
    return new Response('fuera de horario', { status: 200 });
  }
  if (sinHorario && !estaAbierto(ahora)) {
    console.log('OJO: RESPUESTAS_SIN_HORARIO prendida, contestando fuera de horario');
  }

  const store = getStore({ name: 'autorespuesta', consistency: 'strong' });
  const hoy = ahora.toISOString().slice(0, 10);
  const bitacora = (await store.get('bitacora', { type: 'json' })) || [];
  const enviadosHoy = bitacora.filter((b) => b.cuando?.startsWith(hoy) && b.resultado === 'enviado').length;

  // El hilo se guarda ANTES de cualquier freno: lo que hoy no se contesta es
  // justamente el contexto que manana permite entender un mensaje cortado.
  for (const m of entrantes) await hilo.agregar(m.de, 'cliente', m.texto, ahora);

  const nuevos = [];
  for (const m of entrantes) {
    const motivo = freno(m.texto);
    if (motivo) {
      console.log(`freno (${motivo}): ${m.texto.slice(0, 60)}`);
      continue;
    }

    const contactos = await contactosConTelefono(m.de);
    if (!contactos.length) {
      console.log(`sin contacto para ${m.de}: es un lead, no contesta`);
      continue;
    }
    const ficha = { ...contactos[0], modulo: 'Contacts' };

    // La regla de Zoho manda al campo Movil del contacto, y nada mas. El
    // contacto se busca por Movil O por Telefono, asi que uno con el numero
    // solo en Telefono se encontraria pero el WhatsApp no saldria: quedaria
    // la casilla tildada y la bitacora diciendo 'enviado' sin que nadie
    // reciba nada. Se saltea y se deja anotado.
    if (!ficha.Mobile) {
      console.log(`sin Movil cargado (${ficha.Full_Name}): la regla no puede mandar`);
      continue;
    }

    // Solo cuenta lo que SALIO. Una fila 'sombra' es una decision que nunca
    // llego a nadie, y una 'error' tampoco: si cualquiera de las dos trabara
    // el candado, el cliente se queda 12 h sin respuesta por algo que no
    // recibio. Paso en la primera prueba de Ignacio (9-sep).
    const ultima = bitacora.find((b) => b.contacto === ficha.id && b.resultado === 'enviado');
    if (ultima && (ahora - new Date(ultima.cuando)) / 3600000 < HORAS_ENTRE_RESPUESTAS) {
      console.log(`ya le contestamos a ${ficha.Full_Name} hace poco`);
      continue;
    }

    // Se saca el mensaje de ahora, que el prompt ya lo muestra aparte: repetido
    // al final del contexto Y como pregunta, el modelo lo lee dos veces y le da
    // mas peso del que tiene.
    const previos = (await hilo.leer(m.de, ahora)).filter((h) => h.texto !== m.texto);
    nuevos.push({ ...m, ficha, ref: m.id, last_message__s: m.texto, replied_by__s: 'x', hilo: previos });
  }

  if (!nuevos.length) return new Response('nada para contestar', { status: 200 });

  const { porRef } = await elegir(nuevos, { generar, modelo: MODELO_GEMINI });

  const nuevasFilas = [];
  for (const c of nuevos) {
    if (enviadosHoy + nuevasFilas.length >= TOPE_DIA) {
      console.log('cupo del dia agotado');
      break;
    }
    const d = decidirRespuesta(c, porRef[c.ref], { ahora });
    if (!d.responde) {
      console.log(`no contesta (${d.motivo}): ${c.texto.slice(0, 60)}`);
      continue;
    }

    const fila = {
      contacto: c.ficha.id,
      quien: c.ficha.Full_Name,
      numero: c.de,
      entrada: d.entrada.id,
      pregunta: c.texto.slice(0, 300),
      cuando: ahora.toISOString(),
      resultado: ENVIAR ? 'enviado' : 'sombra',
    };

    if (ENVIAR) {
      // Aplanado SIEMPRE. El texto viaja dentro de una variable de plantilla y
      // WhatsApp no acepta ahi saltos dobles ni tabulaciones: si van, Meta
      // rechaza el mensaje y del lado nuestro no se ve nada. Casi todas las
      // entradas tienen vinetas y parrafos, asi que esto no es un caso raro.
      // El camino del cron ya lo hacia (`enviar-zoho.js`); este no, y era un
      // agujero silencioso.
      const cuerpo = aplanar(d.texto);
      const r = cuerpo
        ? await marcarRespuestaAutomatica(c.ficha.modulo, c.ficha.id, cuerpo)
        : { ok: false, motivo: 'texto vacio despues de aplanar' };
      if (!r.ok) {
        fila.resultado = 'error';
        fila.error = r.motivo;
      } else {
        // Se destilda siempre: si queda tildada, el proximo no dispara.
        //
        // Pero NO enseguida. La regla de Zoho corre asincronica, y destildar es
        // otra edicion: si llega antes de que la regla termine de evaluarse, se
        // encuentra la casilla ya en false y no manda nada. Nos paso el 9-sep
        // con la primera prueba de Ignacio, y era peor porque la regla ademas
        // reconfirmaba la casilla en su condicion. La condicion ya se saco; esta
        // espera es el segundo cinturon.
        await new Promise((r) => setTimeout(r, ESPERA_ANTES_DE_DESTILDAR));
        await limpiarRespuestaAutomatica(c.ficha.modulo, c.ficha.id).catch(() => {});
        // Y recien ahi se avisa al equipo. Nunca antes: un aviso de algo que no
        // salio hace que alguien de por contestado un chat que sigue mudo.
        await hilo.agregar(c.de, 'nosotros', cuerpo, ahora);
        const av = await avisar({ ...fila, texto: cuerpo });
        fila.avisado = av.avisado;
        if (!av.avisado) console.log(`sin aviso a Slack: ${av.motivo}`);
      }
    }

    console.log(`${fila.resultado}: ${fila.quien} -> ${fila.entrada}`);
    nuevasFilas.push(fila);
  }

  if (nuevasFilas.length) {
    await store.setJSON('bitacora', [...nuevasFilas, ...bitacora].slice(0, 500));
  }
  return new Response('listo', { status: 200 });
}

/*
 * Todo lo de arriba pasa despues de que un cliente escribio y sigue esperando.
 * Si esto se cae, el cliente no recibe nada y del lado nuestro no queda mas
 * rastro que una linea vacia en los logs. Por eso el grito.
 */
export default async (req) => {
  try {
    return await procesar(req);
  } catch (e) {
    await avisarFalla(
      'Marcos (la respuesta automatica de WhatsApp)',
      e,
      'Hay clientes esperando respuesta. Si varios agentes fallan juntos, sospechar del token de Zoho.'
    );
    // 200 a proposito: un 500 hace que Meta reintente el mismo mensaje, y un
    // reintento sobre algo que ya pudo haber mandado es un mensaje repetido.
    return new Response('falló, avisado', { status: 200 });
  }
};
