// Carril exacto de bajas: el cliente toca el boton de respuesta rapida y la
// cadencia se apaga sola.
//
// Deliberadamente SIN modelo. La lista blanca son los textos que manda el boton,
// comparados exactos despues de normalizar. Un criterio laxo tipo "el mensaje
// contiene Baja" da falsos positivos caros: "quiero dar de baja mi LLC",
// "cuando baja el precio", "me diste de baja el EIN". Cualquiera de esos apaga
// la cadencia de alguien que esta comprando.
//
// Medido el 2026-09-04 sobre las 10.218 conversaciones: con match exacto dan 2
// de 983, las dos botones reales. Con "contiene baja" entraban 12 mensajes mas,
// ninguno era un pedido de baja por boton.
//
// Lo que escribe a mano ("Por favor no quiero recibir mas mensajes", "Sacame")
// NO entra por aca a proposito: eso es el carril dudoso, que necesita criterio
// y por ahora lo mira una persona.
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { RAIZ } from './entorno.js';
import { conversacionesDesde, todasLasConversaciones } from './zoho.js';
import {
  leadsConTelefono,
  leerLead,
  transicionesDe,
  buscarTransicionBaja,
  ejecutarBaja,
  vaciarFechaSiguiente,
  leeLaFecha,
  ESTADOS_YA_FUERA,
} from './escritura.js';

// ─── La lista blanca ───────────────────────────────────────────────────────
// Textos EXACTOS (ya normalizados) que manda el boton de respuesta rapida.
// Para agregar uno: `node descubrir-bajas.js` muestra que estan mandando los
// clientes de verdad. No agregar frases sueltas, solo textos de boton.
export const LISTA_BLANCA = new Set([
  'baja',
  'no me interesa',
]);

/** minusculas, sin tildes, sin puntuacion ni emojis, espacios colapsados. */
export const normalizar = (t) =>
  String(t || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export const esBaja = (texto) => LISTA_BLANCA.has(normalizar(texto));

// ─── Memoria entre corridas ────────────────────────────────────────────────
const DIR = join(RAIZ, 'estado');
const ARCHIVO = join(DIR, 'bajas.json');
const VACIO = { ultimoCorte: null, hechas: {} };

// En la maquina la memoria es un archivo; en Netlify no hay disco que sobreviva
// entre corridas, asi que la funcion carga el blob antes de empezar, lo deja
// aca y escribe lo que quedo al terminar. Mismo mecanismo que `estado.js`.
let memoria = null;

/** La funcion de Netlify llama a esto con lo que venia guardado en el blob. */
export function usarMemoria(inicial) {
  memoria = { ...VACIO, ...(inicial || {}) };
}

/** Lo que hay que guardar en el blob al terminar. */
export const contenido = () => memoria;

export function leerEstado() {
  if (memoria) return memoria;
  try {
    return { ...VACIO, ...JSON.parse(readFileSync(ARCHIVO, 'utf8')) };
  } catch {
    return { ...VACIO };
  }
}

export function guardarEstado(e) {
  if (memoria) {
    memoria = e;
    return;
  }
  mkdirSync(DIR, { recursive: true });
  writeFileSync(ARCHIVO, JSON.stringify(e, null, 2));
}

// Las bajas viejas no aportan nada y el blob se escribe entero en cada corrida.
export function podar(estado, dias = 30) {
  const corte = Date.now() - dias * 24 * 3600 * 1000;
  for (const [k, v] of Object.entries(estado.hechas || {})) {
    if (new Date(v.cuando).getTime() < corte) delete estado.hechas[k];
  }
}

// La llave lleva la hora del mensaje: si la misma persona vuelve a pedir la baja
// mas adelante (porque alguien la reactivo), se procesa de nuevo.
const llave = (c) => `${c.id}:${c.message_time__s || ''}`;

/**
 * Que hacer con un lead. Devuelve la decision sin ejecutarla, para que el modo
 * seco muestre exactamente lo que haria el modo real.
 */
export async function decidir(lead) {
  if (ESTADOS_YA_FUERA.includes(lead.Lead_Status)) {
    return { accion: 'ya_estaba', motivo: `ya esta en ${lead.Lead_Status}` };
  }
  const transiciones = await transicionesDe(lead.id);
  const t = buscarTransicionBaja(transiciones);
  if (!t) {
    return {
      accion: 'revisar',
      motivo: `sin transicion de baja disponible desde "${lead.Lead_Status}"`,
      disponibles: transiciones.map((x) => x.name),
    };
  }
  return { accion: 'dar_de_baja', transicion: { id: t.id, nombre: t.name } };
}

/** Ejecuta lo que dijo `decidir`. */
export async function aplicar(lead, decision) {
  if (decision.accion !== 'dar_de_baja') return { aplicado: false };
  const r = await ejecutarBaja(lead.id, decision.transicion.id);
  const salida = { aplicado: r.ok, estado: r.estado, error: r.ok ? null : r.mensaje || r.codigo };

  // Solo para los tipos cuyas reglas todavia leen la fecha. Para el resto el
  // blueprint alcanza y este PUT seria escribir de mas.
  const despues = r.lead || (await leerLead(lead.id));
  if (r.ok && leeLaFecha(despues)) {
    const f = await vaciarFechaSiguiente(lead.id);
    salida.fechaVaciada = f.ok;
    if (!f.ok) salida.error = `quedo Fecha_Siguiente_Mensaje = ${f.quedo}`;
  }
  return salida;
}

/**
 * Una pasada. En seco no escribe nada y devuelve lo mismo que devolveria el
 * modo real, para poder mirarlo antes de soltarlo.
 */
export async function unaPasada({ escribir = false, historico = false, desdeHoras = null } = {}) {
  const estado = leerEstado();
  const ahora = new Date();

  const desde = desdeHoras
    ? new Date(ahora.getTime() - desdeHoras * 3600 * 1000)
    : estado.ultimoCorte
      ? new Date(new Date(estado.ultimoCorte).getTime() - 3 * 60 * 1000)
      : new Date(ahora.getTime() - 12 * 3600 * 1000);

  const conversaciones = historico
    ? await todasLasConversaciones()
    : await conversacionesDesde(desde);

  // Solo mensajes ENTRANTES: si el ultimo que hablo fue el equipo, el texto que
  // vemos es del equipo. El CRM guarda un mensaje por conversacion, no historial.
  const pedidos = conversaciones.filter(
    (c) => c.conversation_status__s === 'Responded' && esBaja(c.last_message__s)
  );

  const resultados = [];
  for (const c of pedidos) {
    if (estado.hechas[llave(c)]) continue;

    // De la conversacion al lead. Puede haber varios: duplicados con el mismo
    // telefono. Se dan de baja todos.
    const encontrados = new Map();
    const s = c.sender__s;
    if (s?.module?.api_name === 'Leads' && s.id) {
      const l = await leerLead(s.id);
      if (l) encontrados.set(l.id, l);
    }
    for (const l of await leadsConTelefono(c.mobile_number__s)) {
      if (!encontrados.has(l.id)) encontrados.set(l.id, l);
    }

    const leads = [];
    for (const lead of encontrados.values()) {
      const decision = await decidir(lead);
      const ejecucion = escribir ? await aplicar(lead, decision) : { aplicado: false, seco: true };
      leads.push({ lead, decision, ejecucion });
    }

    const fila = {
      conversacion: c.id,
      telefono: c.mobile_number__s,
      texto: c.last_message__s,
      cuando: c.message_time__s,
      contacto: s?.module?.api_name === 'Contacts' ? s : null,
      leads,
      sinLead: leads.length === 0,
    };
    resultados.push(fila);

    // Se marca como hecha solo si de verdad se resolvio. Si quedo algo para
    // revisar a mano, vuelve a aparecer en la proxima pasada.
    const resuelta =
      escribir &&
      leads.length > 0 &&
      leads.every((x) => x.decision.accion === 'ya_estaba' || x.ejecucion.aplicado);
    if (resuelta) estado.hechas[llave(c)] = { cuando: ahora.toISOString(), texto: c.last_message__s };
  }

  if (escribir && !historico) {
    estado.ultimoCorte = ahora.toISOString();
    podar(estado);
    guardarEstado(estado);
  }

  return { desde, leidas: conversaciones.length, pedidos: pedidos.length, resultados };
}
