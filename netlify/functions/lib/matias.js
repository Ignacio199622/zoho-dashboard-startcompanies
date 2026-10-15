/*
 * MATÍAS, el SDR virtual. Fase 0: registrar y mostrar, no contestar.
 *
 * Sale por un numero de la API de Meta que NO esta en Zoho (ver LINEAS mas
 * abajo: desde el 18-sep-2026 el +1 863, antes el +52). Por eso lo que entra
 * ahi no lo ve nadie salvo que lo publiquemos: esta libreria lo publica en dos
 * lugares.
 *
 *   1. Slack, canal #matias, UN HILO POR TELEFONO. El primer mensaje de un
 *      lead abre el hilo; lo que sigue (del lead o de Matias) va adentro.
 *      El `ts` del hilo se guarda en Blobs con la clave del telefono.
 *   2. Zoho, como nota en el lead que tiene ese telefono. Las notas no
 *      despiertan ninguna regla (probado en el Coach, 0 envios), asi que es
 *      seguro escribirlas.
 *
 * ─── LO QUE NO HACE TODAVIA ────────────────────────────────────────────────
 *
 * No contesta. Fase 0 es mirar: que Ignacio vea en Slack lo que entra y como
 * seria la respuesta, antes de que Matias hable solo. La respuesta se agrega
 * en `responder()` cuando el prompt este probado.
 */
import { claveTel } from './tel-clave.js';
import { getStore } from '@netlify/blobs';
import { env } from './entorno.js';
import { leadsConTelefono } from './conversaciones/escritura.js';
import { agregarNota } from './escribir.js';
import { token as tokenZoho } from './conversaciones/zoho.js';
import { reflejar as reflejarEnPortal } from './portal.js';
import { candadoCliente, explicar as explicarCliente } from './matias-cliente.js';

/*
 * ─── EL QUE ESCRIBE PRIMERO (click-to-WhatsApp) ────────────────────────────
 *
 * Ignacio (14-sep-2026): campaña de anuncios que manda directo al +52. Ese lead
 * no existe en Zoho hasta que escribe, así que se crea acá con lo que Meta manda
 * en el mensaje: el nombre del perfil y el `referral` del anuncio (id, título,
 * si vino de Instagram o Facebook). Mismos campos y misma forma que Lead Chain y
 * el código [SC:] de WhatsApp: utm_content = id de anuncio, utm_source = ig/fb,
 * utm_medium = paid, Lead_Source = Meta Ads (18-sep-2026: el canal va en Lead_Source, no en
 * Landing_Origen, que ahora guarda la pagina). Etiqueta "WhatsApp Matias" para
 * que el cerebro sepa que llegó por acá.
 *
 * Ignacio (23-sep-2026): "yo los meteria en la cadencia de agendamiento para cuando
 * el cliente inicie con matias pero siempre guardando todo". Cambia lo de arriba: el
 * que escribe primero SÍ entra al embudo del 786. Dos cosas nuevas:
 *   · `Landing_Origen = 'SDR MATIAS - WP directo'`, al lado de los otros orígenes
 *     (Form Nov Meta, Form Socios Meta, ig-dm-ignacio…), para poder medirlo aparte.
 *   · La etiqueta `Sin Clasificar` DESPUÉS de crear: el alta sigue con trigger [] (así
 *     el origen entra limpio) y el add_tags es el que despierta las reglas y lo deja
 *     en Agendamiento. Es el mismo camino que usan los leads del 786 (medido 23-sep:
 *     los que tienen esa etiqueta quedan en Agendamiento y después Retargeting).
 * El que Matías EMPUJA (no escribió él) no pasa por acá: ese lleva
 * `Contactado por Matías` y conserva su origen. Así se pueden separar las ventas que
 * TRAJO Matías de las que RESCATÓ.
 */
export const TAG_CTWA = 'WhatsApp Matias';
export const TAG_CADENCIA = 'Sin Clasificar';
export const ORIGEN_CTWA = 'SDR MATIAS - WP directo';
export async function crearLead({ numero, nombre, referral }) {
  const tel = `+${String(numero).replace(/\D/g, '')}`;
  // 12-oct-2026: con una sola palabra ("Jose") iba en nombre Y apellido y quedaba "Jose Jose";
  // con perfiles que no son nombre ("?", ".") quedaba "? ?" y las plantillas de Zoho saludaban
  // "Hola ?". Ahora: dos o más palabras se parten; una sola va solo al apellido (Full_Name
  // "Jose"); si no parece un nombre, apellido "WhatsApp" y sin nombre.
  const partes = String(nombre || '').trim().split(/\s+/).filter(Boolean)
    .filter((p) => /[a-záéíóúñü]/i.test(p));
  const campos = {
    Last_Name: partes.length > 1 ? partes.slice(1).join(' ') : (partes[0] || 'WhatsApp'),
    First_Name: partes.length > 1 ? partes[0] : '',
    Mobile: tel,
    Canal_de_contacto: ['WhatsApp'],
    Landing_Origen: ORIGEN_CTWA,
    Tag: [{ name: TAG_CTWA }],
  };
  // Brasil (14-oct-2026): +55 con 12 o 13 dígitos (misma regla que paisDe en matias-cerebro.js).
  const digitosTel = tel.replace(/\D/g, '');
  if (digitosTel.startsWith('55') && (digitosTel.length === 12 || digitosTel.length === 13)) campos.Idioma = 'Português';
  if (referral) {
    const src = /instagram/i.test(referral.source_url || '') ? 'ig' : 'fb';
    campos.Lead_Source = 'Meta Ads'; // Ignacio (15-sep): "fuente de posibles clientes Meta"
    campos.utm_source = src;
    campos.utm_medium = 'paid';
    if (referral.source_id) campos.utm_content = String(referral.source_id);
    if (referral.ctwa_clid) campos.utm_term = String(referral.ctwa_clid).slice(0, 250);
    campos.Description = [`Escribió a Matías desde un anuncio (${src === 'ig' ? 'Instagram' : 'Facebook'}).`, referral.headline ? `Anuncio: ${referral.headline}` : '', referral.source_url ? `URL: ${referral.source_url}` : ''].filter(Boolean).join('\n');
  } else {
    campos.Lead_Source = 'Sin origen de fuente'; // 12-oct-2026: escribió por WhatsApp y no sabemos de dónde vino (antes 'WhatsApp (no sabemos)')
    campos.Description = 'Escribió a Matías por WhatsApp (sin anuncio de origen).';
  }
  const r = await fetch('https://www.zohoapis.com/crm/v6/Leads', {
    method: 'POST',
    headers: { Authorization: `Zoho-oauthtoken ${await tokenZoho()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: [campos], trigger: [] }),
  });
  const j = await r.json().catch(() => ({}));
  const fila = (j.data || [])[0] || {};
  if (!fila?.details?.id) throw new Error(`Zoho no creó el lead: ${JSON.stringify(fila).slice(0, 200)}`);
  const id = fila.details.id;
  // La etiqueta va aparte y CON reglas: es la que lo mete en la cadencia de
  // Agendamiento. Si falla, el lead igual queda creado con todo su origen.
  try {
    const t = await fetch(`https://www.zohoapis.com/crm/v6/Leads/${id}/actions/add_tags`, {
      method: 'POST',
      headers: { Authorization: `Zoho-oauthtoken ${await tokenZoho()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags: [{ name: TAG_CADENCIA }] }),
    });
    if (!t.ok) console.log(`[matias] add_tags ${id} devolvió ${t.status}`);
  } catch (e) { console.log(`[matias] no se pudo etiquetar ${id}: ${e.message}`); }
  return { id, ...campos };
}

/*
 * ─── LAS LÍNEAS DE MATÍAS ──────────────────────────────────────────────────
 *
 * Ignacio (18-sep-2026): "cambiá del WhatsApp de México al de USA". El +52 quedó
 * YELLOW en Meta el 17-sep (barrido de leads viejos) y el fusible lo tenía mudo.
 * El +1 863 591 6277 ya estaba verificado, GREEN, con la app suscripta y las 16
 * plantillas sdr_matias_* aprobadas en su WABA (medido el 18-sep).
 *
 * La línea ACTUAL es por la que salen las aperturas nuevas y por la que contesta
 * a quien escribe por primera vez. Pero una conversación es de UN número: la
 * ventana de 24 h, la calidad y el hilo que ve el lead son de la línea por la que
 * arrancó. Por eso cada ficha `apertura-<tel>` guarda `linea`, y todo envío a un
 * lead con ficha sale por SU línea (`lineaDe`). Las fichas de antes del cambio no
 * tienen el campo: nacieron todas en el +52.
 *
 * Para volver atrás sin tocar código: MATIAS_LINEA=884134968121128 en Netlify.
 */
export const LINEAS = {
  '957724827413499': { numero: '+1 863 591 6277', waba: '1767145927453105', nombre: 'el 863' },
  '884134968121128': { numero: '+52 1 735 128 9637', waba: '853395864309099', nombre: 'el +52' },
};
const LINEA_VIEJA = '884134968121128';
export const LINEA_ACTUAL = LINEAS[env.MATIAS_LINEA] ? env.MATIAS_LINEA : '957724827413499';
export const PHONE_NUMBER_ID = LINEA_ACTUAL;
export const NUMERO = LINEAS[LINEA_ACTUAL].numero;
export const WABA = LINEAS[LINEA_ACTUAL].waba;
const digitosDe = (numero) => String(numero || '').replace(/\D/g, '');

/** Por qué línea se le habla a este lead. Con ficha, la suya; sin ficha, la actual. */
export async function lineaDe(numero, ficha = null) {
  const estado = ficha && typeof ficha === 'object' ? ficha : await estadoDe(numero);
  if (LINEAS[estado.linea]) return estado.linea;
  // Ficha real (apertura enviada o conversación espontánea) sin `linea`: es de antes del 18-sep, del +52.
  if (estado.enviada || estado.desde || estado.espontaneo) return LINEA_VIEJA;
  return LINEA_ACTUAL;
}

/**
 * UN solo POST a Meta para todo lo que manda Matías (texto, plantilla, audio).
 * `cuerpo` es lo que va después de `to` (type + payload). Devuelve el id del
 * mensaje; `linea` se puede fijar (apertura nueva) o se resuelve por la ficha.
 */
/**
 * ¿Este texto es casi igual a uno de los últimos mensajes de Matías? (28-sep: M&K y Poncho
 * recibieron la misma frase 3 veces seguidas; una persona nunca repite así.)
 */
export function repite(texto, previos = []) {
  const bolsa = (t) => new Set(String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').match(/[a-z0-9]{3,}/g) || []);
  const a = bolsa(texto);
  if (a.size < 4) return false;
  return previos.filter((h) => h.de === 'nosotros' || h.de === 'matias').slice(-4).some((h) => {
    const b = bolsa(h.texto);
    let comunes = 0;
    for (const w of a) if (b.has(w)) comunes++;
    return comunes / (a.size + b.size - comunes) >= 0.75;
  });
}

// Dos plantillas al mismo lead en el mismo rato (Poncho, 09:10: horarios + dato en el mismo
// minuto) es lo más robótico que hay. Ninguna plantilla sale si ya salió algo hace menos de esto.
const ENTRE_PLANTILLAS_MS = 30 * 60e3;

export async function mandar(numero, cuerpo, { linea = null, humano = false } = {}) {
  // El candado de cliente (Ignacio, 18-sep: "nunca puede tocar un cliente") vive
  // acá porque es la única puerta a Meta: ninguna apertura, seguimiento,
  // confirmación ni respuesta puede saltearlo. `humano` es para lo que escribe
  // una persona desde el portal por la línea de Matías: esa decisión es suya.
  if (!humano) {
    const cliente = await candadoCliente(numero);
    if (cliente.es) {
      await avisarCliente(numero, cliente).catch(() => {});
      throw new Error(`CLIENTE: ${cliente.quien} (coincide ${cliente.como}). Matías no le escribe.`);
    }
  }
  const claveEnvio = `envio-${claveTel(numero)}`;
  if (cuerpo?.type === 'template' && !humano) {
    const ultimo = await almacen().get(claveEnvio).catch(() => null);
    if (ultimo && Date.now() - new Date(ultimo).getTime() < ENTRE_PLANTILLAS_MS) {
      throw new Error(`ANTI-DUPLICADO: ya le salió un mensaje a las ${ultimo.slice(11, 16)} UTC; esta plantilla no se manda`);
    }
  }
  const porLinea = linea || await lineaDe(numero);
  const r = await fetch(`https://graph.facebook.com/v21.0/${porLinea}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.META_WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: digitosDe(numero), ...cuerpo }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Meta ${r.status}: ${JSON.stringify(j.error || j).slice(0, 200)}`);
  await almacen().set(claveEnvio, new Date().toISOString()).catch(() => {});
  return j.messages?.[0]?.id || null;
}

// Las gemelas de Brasil ("<nombre>_pt", 14-oct-2026) se crean en Meta en pt_BR; el resto sigue en 'es'.
const idiomaPlantilla = (nombre) => (String(nombre || '').endsWith('_pt') ? 'pt_BR' : 'es');
/** Plantilla con parámetros de texto en el cuerpo, en español (o pt_BR si es gemela _pt). */
export const plantilla = (nombre, parametros) => ({
  type: 'template',
  template: { name: nombre, language: { code: idiomaPlantilla(nombre) }, components: [{ type: 'body', parameters: parametros.map((text) => ({ type: 'text', text })) }] },
});
/** Plantilla con un video en el encabezado (pre-llamada, 12-oct-2026). */
export const plantillaVideo = (nombre, video, parametros) => ({
  type: 'template',
  template: {
    name: nombre,
    language: { code: idiomaPlantilla(nombre) },
    components: [
      { type: 'header', parameters: [{ type: 'video', video: { link: video } }] },
      { type: 'body', parameters: parametros.map((text) => ({ type: 'text', text })) },
    ],
  },
});
const ZOHO_UI = 'https://crm.zoho.com/crm/org881745849/tab/Leads';

const CANALES = [env.SLACK_CANAL_MATIAS || '#matias', env.SLACK_CANAL].filter(Boolean);
const FIRMA = { username: 'Matías · SDR', icon_emoji: ':male-office-worker:' };

const almacen = () => getStore({ name: 'matias', consistency: 'strong' });
const clave = (numero) => `hilo-${claveTel(numero)}`;

/*
 * ─── EL FILTRO DE SALIDA ───────────────────────────────────────────────────
 *
 * Regla de Ignacio (13-sep-2026): Matias NUNCA da informacion interna. Ni
 * datos de otros leads, ni cuantos clientes hay, ni nada de Zoho, tokens o
 * credenciales. El prompt lo dice, pero un prompt se puede torcer; esto no.
 *
 * Se corre sobre CADA texto antes de mandarlo. Si salta, el mensaje no sale y
 * se avisa a Slack para que lo mire una persona. Es deterministico a
 * proposito: sin modelo, sin excepciones, sin "depende del contexto".
 */
// La web de la empresa es startcompanies.net (Ignacio, 13-sep); el .io queda por las landings.
// Cualquier subdominio propio: lili., socios., agendaclientes. (el 14-sep Matías se
// quedó mudo con los leads de Lili y de socios porque solo pasaba el dominio pelado).
const LINKS_PERMITIDOS = [/^https?:\/\/([\w-]+\.)*startcompanies\.(net|io)(\/|$)/i, /^https?:\/\/cal\.com\//i, /^https?:\/\/agendaclientes\.startcompanies\.io/i];
// 18-sep: también proveedores, IA/modelos, plataformas internas y cualquier "soy una IA".
const PALABRAS_PROHIBIDAS = /\b(zoho|hubspot|salesforce|pipedrive|kommo|token|api|api ?key|credencial(es)?|contrase[ñn]a|password|base de datos|crm|webhook|netlify|twilio|slack|notion|gemini|openai|chatgpt|gpt|anthropic|claude|llama|prompt|system prompt|instrucciones del sistema|modelo de lenguaje|inteligencia artificial|asistente virtual|soy (un|una) (ia|bot|robot|asistente)|lead ?chain|manychat|n8n|zapier)\b/i;
const TELEFONO = /(\+?\d[\d\s().-]{7,}\d)/g;
const MAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const URL = /https?:\/\/[^\s)>\]]+/gi;

export function filtroSalida(texto) {
  const motivos = [];
  const t = String(texto || '');
  if (PALABRAS_PROHIBIDAS.test(t)) motivos.push(`palabra interna: ${t.match(PALABRAS_PROHIBIDAS)[0]}`);
  for (const u of t.match(URL) || []) if (!LINKS_PERMITIDOS.some((re) => re.test(u))) motivos.push(`link no permitido: ${u}`);
  for (const m of t.match(MAIL) || []) motivos.push(`mail: ${m}`);
  // Un telefono en la respuesta nunca es del lead (ya lo tiene) ni de la
  // empresa (Matias no da otro numero): es un dato ajeno.
  for (const tel of t.match(TELEFONO) || []) if (tel.replace(/\D/g, '').length >= 8) motivos.push(`teléfono: ${tel.trim()}`);
  // Cifras de clientes: "tenemos 1.200 clientes", "más de 900 LLCs abiertas".
  if (/\b\d[\d.,]*\s*(clientes|llcs?|empresas|leads|usuarios)\b/i.test(t)) motivos.push('cifra de clientes');
  return { pasa: motivos.length === 0, motivos };
}

/** ¿Este evento de Meta es de una línea de Matías (la actual o la vieja)? Se decide por el metadata. */
export function esDeMatias(cuerpo) { return Boolean(lineaDelEvento(cuerpo)); }

/** La línea (phone_number_id) por la que entró el evento, si es de Matías. */
export function lineaDelEvento(cuerpo) {
  for (const entrada of cuerpo?.entry || []) {
    for (const cambio of entrada.changes || []) {
      const id = cambio.value?.metadata?.phone_number_id;
      if (LINEAS[id]) return id;
    }
  }
  return null;
}

async function slack(metodo, cuerpo) {
  const r = await fetch(`https://slack.com/api/${metodo}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
    body: JSON.stringify(cuerpo),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error);
  return j;
}

// Con firma si el scope esta, sin firma si Slack la rechaza. Y si el canal
// #matias no existe o el bot no esta invitado, cae al canal paracaidas.
export async function enCanal(texto) { return publicar({ text: texto }); }
async function publicar(cuerpo) {
  let ultimo = 'sin canal';
  for (const canal of CANALES) {
    for (const firma of [FIRMA, null]) {
      try {
        return { ...(await slack('chat.postMessage', { channel: canal, ...cuerpo, ...(firma || {}) })), canal };
      } catch (e) {
        ultimo = e.message;
        if (!/missing_scope|invalid_arguments/.test(e.message)) break;
      }
    }
  }
  throw new Error(ultimo);
}

/**
 * Registra un mensaje en el hilo del telefono (Slack) y como nota en Zoho.
 * `de` es 'lead' o 'matias'. Nunca tira: devuelve que pudo y que no.
 */
const fechaAR = (iso) => new Date(iso).toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });

/**
 * La cabecera del hilo dice de entrada quién arrancó (Ignacio, 16-sep: "ella no
 * nos escribió, Matías escribió"): 📲 el lead escribió solo · 🆕 Matías abrió un
 * form nuevo · 🧹 Matías retomó un lead viejo (barrido) · 🤖 Matías le escribió
 * por otra cosa (confirmación, no-show). Cuando el lead contesta, se le agrega
 * "💬 contestó" a esa misma cabecera.
 */
function cabeceraDe({ de, nombre, link, apertura, NUMERO }) {
  if (de === 'lead') return { corto: `📲 ${nombre} le escribió a Matías`, largo: `📲 *${nombre}* le escribió a Matías (${NUMERO}) · ${link}` };
  const cuando = apertura?.creado ? `, entró el ${fechaAR(apertura.creado)}` : '';
  if (apertura?.tipo === 'nuevo') return { corto: `🆕 Matías abrió a ${nombre} (form nuevo)`, largo: `🆕 *Matías abrió a ${nombre}* · form nuevo (${apertura.origen}${cuando}) · ${link}` };
  if (apertura?.tipo === 'viejo') return { corto: `🧹 Matías retomó a ${nombre} (lead viejo)`, largo: `🧹 *Matías retomó a ${nombre}* · lead viejo del barrido (${apertura.origen}${cuando}) · ${link}` };
  return { corto: `🤖 Matías le escribió a ${nombre}`, largo: `🤖 *Matías le escribió a ${nombre}* (${NUMERO}) · ${link}` };
}

export async function registrar({ numero, de, texto, cuando = new Date(), apertura = null }) {
  const resultado = { slack: null, zoho: null, lead: null };
  const NUMERO = LINEAS[await lineaDe(numero)].numero; // el número por el que habla con ESTE lead
  if (!env.SLACK_BOT_TOKEN) resultado.slack = 'sin SLACK_BOT_TOKEN';

  // 1. El lead en Zoho, para el link y la nota.
  let lead = null;
  try {
    lead = (await leadsConTelefono(`+${String(numero).replace(/\D/g, '')}`))[0] || null;
  } catch (e) {
    resultado.zoho = `buscar lead: ${e.message}`;
  }
  resultado.lead = lead;
  const nombre = lead?.Full_Name || `+${numero}`;
  const link = lead ? `<${ZOHO_UI}/${lead.id}|abrir en Zoho>` : '_(no está en Zoho)_';

  // 2. Slack: hilo por telefono.
  if (!resultado.slack) {
    try {
      const store = almacen();
      const guardado = await store.get(clave(numero), { type: 'json' });
      let ts = guardado?.ts, canal = guardado?.canal;
      if (!ts) {
        const c = cabeceraDe({ de, nombre, link, apertura, NUMERO });
        const cabecera = await publicar({
          text: c.corto,
          blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `${c.largo}\n_La conversación sigue en este hilo._` } }],
          unfurl_links: false,
        });
        ts = cabecera.ts; canal = cabecera.canal;
        await store.setJSON(clave(numero), { ts, canal, lead: lead?.id || null, desde: cuando.toISOString(), inicio: de, cabecera: c });
      } else if (de === 'lead' && guardado?.inicio === 'matias' && !guardado.contesto && guardado.cabecera) {
        // Primera respuesta a un hilo que abrió Matías: se marca en la cabecera.
        const c = guardado.cabecera;
        await slack('chat.update', {
          channel: canal, ts, text: `${c.corto} · 💬 contestó`,
          blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `${c.largo} · *💬 contestó*\n_La conversación sigue en este hilo._` } }],
        }).catch(() => {});
        await store.setJSON(clave(numero), { ...guardado, contesto: cuando.toISOString() });
      }
      const quien = de === 'lead' ? `💬 *${nombre}*` : '🤖 *Matías*';
      await slack('chat.postMessage', {
        channel: canal, thread_ts: ts, text: `${quien}: ${texto}`,
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `${quien}\n> ${String(texto).split('\n').join('\n> ')}` } }],
        ...FIRMA,
      }).catch(async (e) => {
        if (!/missing_scope|invalid_arguments/.test(e.message)) throw e;
        await slack('chat.postMessage', { channel: canal, thread_ts: ts, text: `${quien}: ${texto}` });
      });
      resultado.slack = 'ok';
    } catch (e) {
      resultado.slack = e.message;
    }
  }

  // 2b. El portal de WhatsApp (api-bot), para que el equipo lo vea en su bandeja. Va el
  // nombre para que el portal no lo muestre como "Desconocido".
  // Las propuestas que NO salieron ("[APERTURA PROPUESTA, no enviada] ...") son para Slack:
  // al lead nunca le llegaron, así que en la bandeja del equipo no van.
  const esPropuesta = /^\[[^\]]*no envia/i.test(String(texto));
  resultado.portal = esPropuesta ? 'propuesta' : await reflejarEnPortal({ numero, de, texto, cuando, lead, nombre: lead?.Full_Name || undefined });

  // 3. Zoho: nota en el lead. Si el portal ya está vinculado a la ficha y dejó la suya
  // (contesta `zoho` con módulo e id), no se duplica desde acá.
  if (resultado.portal?.zoho?.id) resultado.zoho = 'portal';
  if (lead && !resultado.zoho) {
    try {
      const hora = cuando.toISOString().slice(0, 16).replace('T', ' ');
      await agregarNota(lead.id,
        de === 'lead' ? `WhatsApp a Matías (${hora} UTC)` : `Matías respondió (${hora} UTC)`,
        `${de === 'lead' ? 'El lead escribió' : 'Matías escribió'} por el ${NUMERO}:\n\n${texto}`);
      resultado.zoho = 'ok';
    } catch (e) {
      resultado.zoho = e.message;
    }
  } else if (!lead && !resultado.zoho) {
    resultado.zoho = 'sin lead con ese teléfono';
  }

  return resultado;
}

/**
 * Los dos tildes azules y el "escribiendo…" (Ignacio, 18-sep: "lo más humano posible").
 * Meta lo hace con un solo POST: status read sobre el mensaje del lead, y el
 * typing_indicator dura hasta 25 s o hasta que sale la respuesta. Nunca tira.
 */
export async function leidoYEscribiendo(numero, mensajeId, { escribiendo = true } = {}) {
  if (!mensajeId) return false;
  try {
    const linea = await lineaDe(numero);
    const cuerpo = { messaging_product: 'whatsapp', status: 'read', message_id: mensajeId, ...(escribiendo ? { typing_indicator: { type: 'text' } } : {}) };
    const r = await fetch(`https://graph.facebook.com/v21.0/${linea}/messages`, {
      method: 'POST', headers: { Authorization: `Bearer ${env.META_WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo),
    });
    return r.ok;
  } catch { return false; }
}

/*
 * ─── EL TURNO ──────────────────────────────────────────────────────────────
 *
 * Edgar (18-sep) mandó "Incluyes a mi socio" dos veces y después su mail: tres
 * workers, cada uno con su espera al azar, y Matías contestó dos veces seguidas.
 * Regla: contesta SOLO el worker del último mensaje del lead. Cada mensaje que
 * entra toma el turno (guarda su id); antes de reservar y antes de mandar, el
 * worker pregunta si el turno sigue siendo suyo. Si otro mensaje llegó después,
 * ese otro worker tiene el turno y este se calla.
 */
export async function tomarTurno(numero, mensajeId) {
  if (!mensajeId) return;
  await almacen().set(`turno-${claveTel(numero)}`, String(mensajeId)).catch(() => {});
}
export async function esMiTurno(numero, mensajeId) {
  if (!mensajeId) return true;
  const t = await almacen().get(`turno-${claveTel(numero)}`).catch(() => null);
  return !t || t === String(mensajeId);
}

/**
 * Suma UNA etiqueta al lead conservando las que ya tiene, con trigger vacío
 * (no despierta cadencias). Ignacio (18-sep-2026): "Contactado por Matías" al
 * abrir, "Agendó con Matías" al reservar (esa la pone cal-reconciliar.js). Nunca
 * tira: si Zoho falla, la apertura ya salió y no hay nada que deshacer.
 */
export const ETIQUETA_CONTACTADO = 'Contactado por Matías';
export async function etiquetarLead(leadId, etiqueta, tagsActuales = []) {
  try {
    const tags = (tagsActuales || []).map((t) => t?.name || t).filter(Boolean);
    if (tags.includes(etiqueta)) return 'ya estaba';
    const r = await fetch('https://www.zohoapis.com/crm/v6/Leads', {
      method: 'PUT',
      headers: { Authorization: `Zoho-oauthtoken ${await tokenZoho()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: [{ id: leadId, Tag: [...tags, etiqueta].map((name) => ({ name })) }], trigger: [] }),
    });
    const j = await r.json().catch(() => ({}));
    return j.data?.[0]?.code || `HTTP ${r.status}`;
  } catch (e) {
    return `error: ${e.message}`;
  }
}

/** Manda un texto libre por la línea del lead (solo dentro de la ventana de 24 h). */
export async function enviarTexto(numero, texto, opciones = {}) {
  return mandar(numero, { type: 'text', text: { body: texto } }, opciones);
}

/**
 * Cuando el candado frena: una sola vez por número avisa en el hilo de Slack y
 * deja la nota en el lead, para que el equipo vea por qué Matías se calló.
 */
export async function avisarCliente(numero, cliente, lead = null) {
  const store = almacen();
  const k = `apertura-${claveTel(numero)}`;
  const estado = (await store.get(k, { type: 'json' }).catch(() => null)) || {};
  if (estado.clienteAvisado) return false;
  await store.setJSON(k, { ...estado, clienteAvisado: new Date().toISOString() });
  const texto = explicarCliente(cliente);
  if (!(await enHilo(numero, texto))) await enCanal(`${texto} · +${String(numero).replace(/\D/g, '')}`).catch(() => {});
  const id = lead?.id || estado.lead;
  if (id) await agregarNota(id, 'Matías no escribió: es cliente', `${cliente.quien} (coincide ${cliente.como}). Matías no le escribe ni le manda seguimientos. Si hace falta, le escribe una persona.`).catch(() => {});
  return true;
}

/** Publica en el hilo de Slack del lead, sin tocar Zoho. Para las propuestas en sombra. */
export async function enHilo(numero, texto) {
  const guardado = await almacen().get(clave(numero), { type: 'json' });
  if (!guardado?.ts) return false;
  const base = { channel: guardado.canal, thread_ts: guardado.ts, text: texto };
  await slack('chat.postMessage', { ...base, ...FIRMA }).catch(() => slack('chat.postMessage', base));
  return true;
}

/** El hilo de la conversacion tal como lo guarda `lib/hilo.js` (compartido con Marcos). */
export { leer as leerHilo } from './hilo.js';

/** La ficha interna `apertura-<tel>` tal cual está (o {} si no hay). */
export async function estadoDe(numero) {
  const estado = await almacen().get(`apertura-${claveTel(numero)}`, { type: 'json' }).catch(() => null);
  return estado && typeof estado === 'object' ? estado : {};
}

/** Cierra el seguimiento de un lead (no se le escribe más). Idempotente. */
export async function cerrarApertura(numero, motivo, ahora = new Date()) {
  const store = almacen();
  const k = `apertura-${claveTel(numero)}`;
  const estado = await store.get(k, { type: 'json' }).catch(() => null);
  await store.setJSON(k, { ...(estado && typeof estado === 'object' ? estado : {}), cerrado: motivo, cerradoEl: ahora.toISOString() });
}

/**
 * Marca un evento en la ficha interna del lead (`apertura-<tel>`): contestó,
 * frenado, respondió Matías. Es lo que lee el reporte diario. Si el lead no
 * tiene apertura (escribió él primero), la crea como conversación espontánea.
 */
export async function marcarEvento(numero, cambios, ahora = new Date()) {
  const store = almacen();
  const k = `apertura-${claveTel(numero)}`;
  let estado = await store.get(k, { type: 'json' }).catch(() => null);
  if (!estado || typeof estado !== 'object') estado = { espontaneo: true, desde: ahora.toISOString() };
  await store.setJSON(k, { ...estado, ...cambios });
}

/*
 * ─── EL FUSIBLE ────────────────────────────────────────────────────────────
 *
 * Ignacio (13-sep-2026): "la cacería, pero sin bloqueos". Meta califica cada
 * número por lo que hace la gente con sus mensajes (bloquear, reportar). La
 * calificación es POR NÚMERO: el 786 no se entera, y desde el 18-sep tampoco
 * se mezclan el 863 y el +52 (cada uno tiene su blob `salud-<línea>`). Si una
 * línea baja de GREEN o deja de estar CONNECTED, lo que sale por ella se calla
 * solo: la apertura y los seguimientos pasan a proponer en #sdr y no mandan
 * nada. Cuando vuelve a GREEN, retoma solo. Se lee UNA vez cada 30 min (queda
 * en Blobs), no en cada envío.
 */
const SALUD_CADA_MIN = 30;
const SALUD_CAMPOS = 'quality_rating,status,messaging_limit_tier';

// Modo cuidado (línea YELLOW): cuántos envíos proactivos por día y por pasada
// deja salir por esa línea. Meta reevalúa la calidad con los últimos 7 días, así
// que la idea es goteo: pocos, primero a los que contestaron, y que no se
// acumulen. `MATIAS_CUIDADO_DIA` en Netlify lo cambia sin tocar código.
export const CUIDADO_POR_DIA = Number(env.MATIAS_CUIDADO_DIA || 40);
export const CUIDADO_POR_PASADA = Number(env.MATIAS_CUIDADO_PASADA || 6);

/**
 * Cupo del modo cuidado para una línea: blob `cuidado-<línea>-<fecha>`.
 * `queda()` dice si se puede mandar uno más; `gasto()` lo descuenta.
 */
export function cupoCuidado(linea, ahora = new Date()) {
  const store = almacen();
  const clave = `cuidado-${linea}-${ahora.toISOString().slice(0, 10)}`;
  let usados = null;
  let pasada = 0;
  return {
    clave,
    async queda() {
      if (usados === null) usados = Number(await store.get(clave).catch(() => 0)) || 0;
      return usados < CUIDADO_POR_DIA && pasada < CUIDADO_POR_PASADA;
    },
    async gasto() {
      usados = (usados || 0) + 1; pasada++;
      await store.set(clave, String(usados));
    },
    usados: () => usados || 0,
  };
}

export async function saludDelNumero(ahora = new Date(), linea = LINEA_ACTUAL) {
  const store = almacen();
  const previa = await store.get(`salud-${linea}`, { type: 'json' }).catch(() => null);
  if (previa?.leido && ahora - new Date(previa.leido) < SALUD_CADA_MIN * 60000) return previa;

  let salud;
  try {
    const r = await fetch(`https://graph.facebook.com/v21.0/${linea}?fields=${SALUD_CAMPOS}&access_token=${env.META_WHATSAPP_TOKEN}`);
    const j = await r.json();
    if (!r.ok || j.error) throw new Error(JSON.stringify(j.error || j).slice(0, 200));
    const ok = j.quality_rating === 'GREEN' && j.status === 'CONNECTED';
    // Ignacio (18-sep): "levantá el fusible y sé cuidadoso del +52". YELLOW no
    // frena todo: la línea sigue en modo cuidado (cupo chico por día, ver
    // CUIDADO_POR_DIA); RED o desconectada sí frena.
    const cuidado = !ok && j.quality_rating === 'YELLOW' && j.status === 'CONNECTED';
    salud = { ok, cuidado, calidad: j.quality_rating, estado: j.status, tope: j.messaging_limit_tier || null, leido: ahora.toISOString() };
  } catch (e) {
    // Sin lectura no se frena a ciegas: vale la última conocida. Si nunca
    // hubo una, se asume sana y se deja rastro para el log.
    salud = { ...(previa || { ok: true }), leido: ahora.toISOString(), errorLectura: e.message };
  }
  salud.linea = linea;
  salud.motivo = salud.ok ? null : `${LINEAS[linea].nombre} está ${salud.calidad || '?'} / ${salud.estado || '?'}`;

  // Aviso a #sdr solo cuando cambia (sano → cuidado → tocado y vuelta).
  const nivel = (s) => (s.ok ? 'sano' : s.cuidado ? 'cuidado' : 'frenado');
  if (previa && nivel(previa) !== nivel(salud)) {
    const texto = salud.ok
      ? `✅ ${LINEAS[linea].nombre} volvió a ${salud.calidad}. Matías retoma lo que sale por esa línea.`
      : salud.cuidado
        ? `🟡 Modo cuidado: ${salud.motivo}. Por esa línea salen como mucho ${CUIDADO_POR_DIA} seguimientos por día, primero a los que ya contestaron.`
        : `🛑 Fusible: ${salud.motivo}. Lo que sale por esa línea queda como propuesta en los hilos hasta que Meta la devuelva a GREEN.`;
    await publicar({ text: texto }).catch(() => {});
  }
  await store.setJSON(`salud-${linea}`, salud);
  return salud;
}

/**
 * Para una pasada que toca leads de las dos líneas: `const sano = fusible(ahora);
 * (await sano(linea)).ok`. Lee cada línea una sola vez por pasada.
 */
export function fusible(ahora = new Date()) {
  const leidas = {};
  return async (linea = LINEA_ACTUAL) => {
    if (!leidas[linea]) leidas[linea] = await saludDelNumero(ahora, linea);
    return leidas[linea];
  };
}

/*
 * ─── ACUSES DE META ────────────────────────────────────────────────────────
 *
 * Meta manda `statuses` por cada mensaje: sent, delivered, read, failed. Hasta
 * el 13-sep se tiraban. Sirven para dos cosas: saber si el silencio es porque
 * no leen o porque no llega, y enterarse de un opt-out (131050) o del tope de
 * marketing por usuario (131049) para cerrar ese lead y no insistir.
 */
export function acusesDeMatias(cuerpo) {
  const out = [];
  if (!esDeMatias(cuerpo)) return out;
  for (const entrada of cuerpo?.entry || []) {
    for (const cambio of entrada.changes || []) {
      for (const s of cambio.value?.statuses || []) {
        const e = s.errors?.[0];
        out.push({
          numero: s.recipient_id, estado: s.status, id: s.id,
          cuando: s.timestamp ? new Date(Number(s.timestamp) * 1000) : new Date(),
          error: e ? { codigo: e.code, titulo: e.title || e.message || '', detalle: e.error_data?.details || '' } : null,
        });
      }
    }
  }
  return out;
}

const ACUSE_A_CAMPO = { delivered: 'entregado', read: 'leido' };
const CIERRA_POR_ERROR = { 131050: 'pidió no recibir marketing (opt-out en Meta)', 131049: 'Meta le frenó el marketing a este usuario' };

/** Registra un acuse en la ficha del lead. Solo si tiene apertura: no inventa fichas. */
export async function registrarAcuse(acuse, ahora = new Date()) {
  const store = almacen();
  const k = `apertura-${claveTel(acuse.numero)}`;
  const estado = await store.get(k, { type: 'json' }).catch(() => null);
  if (!estado || typeof estado !== 'object') return false;
  if (acuse.estado === 'failed') {
    const cierre = CIERRA_POR_ERROR[acuse.error?.codigo];
    const fallo = `${acuse.error?.codigo || '?'} ${acuse.error?.titulo || ''} ${acuse.error?.detalle || ''}`.trim();
    const mensajes = { ...(estado.mensajes || {}), [acuse.id]: { ...(estado.mensajes?.[acuse.id] || {}), fallo } };
    await store.setJSON(k, { ...estado, fallo, falloEl: acuse.cuando.toISOString(), mensajes, ...(cierre ? { cerrado: cierre, cerradoEl: ahora.toISOString() } : {}) });
    await enHilo(acuse.numero, `⚠️ Meta no entregó el mensaje: ${fallo}${cierre ? `\n🛑 Se cierra el seguimiento: ${cierre}.` : ''}`).catch(() => {});
    return true;
  }
  const campo = ACUSE_A_CAMPO[acuse.estado];
  if (!campo) return false;
  // Cada mensaje tiene su acuse (28-sep: antes solo quedaba el primero de todos y no se
  // sabía si le había llegado la disculpa). `entregado`/`leido` siguen siendo el primero;
  // `mensajes` guarda los últimos 30 por id de Meta y el hilo de Slack lo muestra.
  const cuando = acuse.cuando.toISOString();
  const mensajes = { ...(estado.mensajes || {}) };
  const m = { ...(mensajes[acuse.id] || {}) };
  if (m[campo]) return false;
  m[campo] = cuando;
  mensajes[acuse.id] = m;
  const ids = Object.keys(mensajes);
  for (const viejo of ids.slice(0, Math.max(0, ids.length - 30))) delete mensajes[viejo];
  await store.setJSON(k, { ...estado, [campo]: estado[campo] || cuando, [`${campo}Ultimo`]: cuando, mensajes });
  const hora = new Intl.DateTimeFormat('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', minute: '2-digit' }).format(acuse.cuando);
  await enHilo(acuse.numero, campo === 'entregado' ? `✓✓ Le llegó el mensaje (${hora} AR)` : `👁 Lo leyó (${hora} AR)`).catch(() => {});
  return true;
}
