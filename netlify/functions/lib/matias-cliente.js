/*
 * ─── EL CANDADO DE CLIENTE ─────────────────────────────────────────────────
 *
 * Ignacio (18-sep-2026): "nunca puede tocar un cliente". El 17-sep el barrido
 * le mandó la apertura a Samah (Aletheia Meridian LLC): su lead de junio tenía
 * el número español y su ficha de cliente, creada tres días después y nunca
 * fusionada, tiene el de Costa Rica. Mirar solo el teléfono contra Contactos
 * frenó 2 de 689 aperturas.
 *
 * Esto es UN solo lugar por el que pasa todo lo que Matías manda (`mandar`, en
 * matias.js) y todo lo que decide abrir o contestar. Mira a la persona en los
 * tres módulos donde vive un cliente (Contactos, Propietarios de LLC y la LLC)
 * y por las tres puntas que puede tener (teléfono con sus variantes, mail y
 * nombre). Si alguna coincide, Matías no le escribe, cierra la ficha, se lo
 * pasa al equipo y deja la nota. El costo de equivocarse para el lado del
 * bloqueo es que un lead nuevo no reciba el pitch y lo mire una persona; el
 * costo del otro lado es lo de Samah. Por eso, ante la duda, frena.
 *
 * La respuesta queda en la ficha `apertura-<tel>` (`cliente`), así cada envío
 * no vuelve a preguntarle a Zoho: un "no es cliente" vale 24 h (alguien puede
 * pasar a cliente mañana), un "sí" es para siempre.
 */
import { claveTel } from './tel-clave.js';
import { getStore } from '@netlify/blobs';
import { env } from './entorno.js';
import { get } from './conversaciones/zoho.js';

const almacen = () => getStore({ name: 'matias', consistency: 'strong' });
const digitos = (n) => String(n || '').replace(/\D/g, '');
const c = (s) => encodeURIComponent(s);
const NO_ES_CLIENTE_VALE_H = 24;

/** Nombre sin acentos, minúsculas, sin signos, una palabra por espacio. */
export const normalizar = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

/** Para probar: `MATIAS_NUMEROS_PRUEBA=5493814727017,...` en Netlify saltea el candado en esos números. */
const exento = (numero) => (env.MATIAS_NUMEROS_PRUEBA || '').split(',').map(digitos).filter(Boolean).includes(digitos(numero));

/**
 * Las formas en que ese mismo teléfono puede estar guardado: con y sin `+`, y
 * con y sin el 9 argentino o el 1 mexicano (Zoho guarda de las dos maneras,
 * ver project_telefonos_duplicados).
 */
export function variantesDe(numero) {
  const d = digitos(numero);
  if (d.length < 8) return [];
  const bases = new Set([d]);
  if (/^549\d{10}$/.test(d)) bases.add('54' + d.slice(3));
  if (/^54[1-9]\d{9}$/.test(d) && !d.startsWith('549')) bases.add('549' + d.slice(2));
  if (/^521\d{10}$/.test(d)) bases.add('52' + d.slice(3));
  if (/^52[2-9]\d{9}$/.test(d)) bases.add('521' + d.slice(2));
  return [...bases].flatMap((b) => [`+${b}`, b]);
}

const criterioTelefono = (campos, variantes) => `(${campos.flatMap((f) => variantes.map((v) => `(${f}:equals:${v})`)).join('or')})`;

async function buscar(modulo, query, campos) {
  const j = await get(`${modulo}/search?${query}&fields=${campos}&per_page=20`);
  if (j?._error) throw new Error(`Zoho ${modulo}: ${j._error} ${j._mensaje || ''}`);
  return j?.data || [];
}

const quienEs = (modulo, r) => {
  if (modulo === 'Contacts') return `${r.Full_Name}${r.Account_Name?.name ? ` (${r.Account_Name.name})` : ''}`;
  if (modulo === 'Propietarios_LLC') return `${r.Name}${r.LLC?.name ? ` (${r.LLC.name})` : ''}`;
  return `LLC ${r.Account_Name}`;
};
// El módulo de propietarios es custom y su URL no se adivina: link solo para Contactos y LLCs.
const linkDe = (modulo, id) => (modulo === 'Propietarios_LLC' ? '' : `https://crm.zoho.com/crm/org881745849/tab/${modulo}/${id}`);

/**
 * Busca a la persona en Zoho. Devuelve `{ es, como, quien, modulo, id }`.
 * `nombre` y `email` son los del lead (si se tienen): con el teléfono solo,
 * Samah no aparecía.
 */
export async function buscarCliente({ numero, nombre = '', email = '' }) {
  const variantes = variantesDe(numero);
  const hallado = (modulo, r, como) => ({ es: true, como, quien: quienEs(modulo, r), modulo, id: r.id, link: linkDe(modulo, r.id) });

  // 1. Teléfono, en los tres módulos.
  if (variantes.length) {
    for (const [modulo, campos, fields] of [
      ['Contacts', ['Mobile', 'Phone'], 'id,Full_Name,Account_Name'],
      ['Propietarios_LLC', ['Tel_fono'], 'id,Name,LLC'],
      ['Accounts', ['Phone'], 'id,Account_Name'],
    ]) {
      const r = (await buscar(modulo, `criteria=${c(criterioTelefono(campos, variantes))}`, fields))[0];
      if (r) return hallado(modulo, r, 'teléfono');
    }
  }

  // 2. Mail, en Contactos y Propietarios.
  const mail = String(email || '').trim().toLowerCase();
  if (mail && mail.includes('@')) {
    for (const [modulo, campos, fields] of [
      ['Contacts', ['Email', 'Secondary_Email'], 'id,Full_Name,Account_Name'],
      ['Propietarios_LLC', ['Email', 'Secondary_Email'], 'id,Name,LLC'],
    ]) {
      const r = (await buscar(modulo, `criteria=${c(`(${campos.map((f) => `(${f}:equals:${mail})`).join('or')})`)}`, fields))[0];
      if (r) return hallado(modulo, r, 'mail');
    }
  }

  // 3. Nombre. Con dos palabras o más: igual o contenido. Con una sola ("Samah"):
  // solo si en toda la base hay UNA persona con ese nombre de pila. "Juan" no frena.
  const n = normalizar(nombre);
  const palabras = n.split(' ').filter((w) => w.length >= 2);
  if (palabras.length && n.length >= 4) {
    const hits = [];
    for (const [modulo, fields, campo] of [['Contacts', 'id,Full_Name,Account_Name', 'Full_Name'], ['Propietarios_LLC', 'id,Name,LLC', 'Name']]) {
      for (const r of await buscar(modulo, `word=${c(palabras.length >= 2 ? n : palabras[0])}`, fields)) hits.push({ modulo, r, nombre: normalizar(r[campo]) });
    }
    if (palabras.length >= 2) {
      // Igual, o el nombre del lead es el arranque del de la ficha ("Oscar Gonzalez" →
      // "Oscar González Carrillo"). Por palabras enteras, no por substring: "Luis Enrique"
      // adentro de "Francisco Luis Enrique Cervantes" son dos nombres de pila, no la misma persona.
      const arranca = (ficha) => { const f = ficha.split(' '); return f.length >= palabras.length && palabras.every((w, i) => f[i] === w); };
      const h = hits.find((x) => x.nombre === n || arranca(x.nombre));
      if (h) return hallado(h.modulo, h.r, 'nombre');
    } else if (palabras[0].length >= 4) {
      const mismos = hits.filter((x) => x.nombre.split(' ')[0] === palabras[0]);
      // La misma persona suele estar en Contactos y en Propietarios con el nombre
      // escrito distinto ("Samah El Mernissi" / "Samah El mernissi Tajioui"): cuenta
      // como una si coinciden nombre y primer apellido.
      const personas = new Set(mismos.map((x) => x.nombre.split(' ').slice(0, 2).join(' ')));
      if (mismos.length && personas.size === 1) return hallado(mismos[0].modulo, mismos[0].r, 'nombre de pila único');
    }
  }
  return { es: false };
}

/**
 * El candado con memoria. Lee la ficha `apertura-<tel>`; si ya sabe, contesta
 * sin ir a Zoho. Si no, busca y guarda. Cuando es cliente, además cierra la
 * ficha y la marca como del equipo, así ningún seguimiento, confirmación ni
 * no-show la vuelve a tocar.
 */
export async function candadoCliente(numero, { nombre = '', email = '', ficha = null, ahora = new Date() } = {}) {
  if (exento(numero)) return { es: false, exento: true };
  const store = almacen();
  const k = `apertura-${claveTel(numero)}`;
  const estado = ficha && typeof ficha === 'object' ? ficha : (await store.get(k, { type: 'json' }).catch(() => null)) || {};
  const previo = estado && typeof estado === 'object' ? estado.cliente : null;
  if (previo?.es) return previo;
  // Un "no" reciente vale, salvo que antes se buscó solo por teléfono y ahora hay nombre o mail.
  const reciente = previo?.chequeado && ahora - new Date(previo.chequeado) < NO_ES_CLIENTE_VALE_H * 3600000;
  if (reciente && (previo.conDatos || !(nombre || email))) return previo;

  const r = await buscarCliente({ numero, nombre, email });
  const cliente = { ...r, chequeado: ahora.toISOString(), conDatos: Boolean(nombre || email) };
  const actual = (await store.get(k, { type: 'json' }).catch(() => null)) || {};
  const base = actual && typeof actual === 'object' ? actual : {};
  await store.setJSON(k, r.es
    ? { ...base, cliente, cerrado: base.cerrado || 'es cliente', cerradoEl: base.cerradoEl || ahora.toISOString(), humano: true, humanoDesde: base.humanoDesde || ahora.toISOString(), humanoQuien: base.humanoQuien || 'candado de cliente' }
    : { ...base, cliente });
  return cliente;
}

/** Texto para el hilo de Slack y la nota de Zoho. */
export const explicar = (cliente) => `🔒 Es cliente: ${cliente.quien} (coincide ${cliente.como}). Matías no le escribe; queda para el equipo. ${cliente.link ? `<${cliente.link}|ver ficha>` : ''}`.trim();
