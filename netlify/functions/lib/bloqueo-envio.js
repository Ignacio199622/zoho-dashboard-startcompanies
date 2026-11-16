// Candado de partners (Bloqueo_de_envio), corrida automatica (10-nov-2026).
// Misma logica que crm/auditoria/bloqueo-envio.mjs (19-oct, reclamo de Tax Solutions):
// tilda Bloqueo_de_envio en Cuentas, Contactos y Tratos que no pueden recibir nada con
// la marca Start Companies:
//   1. la cuenta tiene Socio cargado (cliente de un socio), o
//   2. su mail o telefono se repite en MAS DE 5 fichas (mail/WhatsApp de un socio o gestoria).
// Un trato se bloquea si su cuenta o su contacto estan bloqueados, o si Partner no es
// vacio ni "Start Companies". Nunca destilda (sacar un bloqueo es a mano), salvo las
// EXCEPCIONES por repeticion. Escribe con trigger [] para no disparar reglas.
import { paginado, tokenActual } from './control-crm/zoho.js';

const LIMITE = 5;
const EXCEPCIONES = new Set(['jmoglietti@gmail.com', 'g.peiretti@hotmail.com']);
// Fichas del equipo y de prueba: no se bloquean (11-nov).
const INTERNOS = /^(empresa de prueba|Ignacio Campo|Jose Ignacio Navarro)$/i;
// Socios empresa por Nombre_de_Partner del contacto (texto libre). Lucas Rayyan = World Legal Consulting.
const SOCIOS_EMPRESA = /fixcal|abotax|globo ?bank|madeira|tax solutions|world legal|lucas rayyan|management creation/i;
const mail = (v) => (v || '').trim().toLowerCase() || null;
const tel = (v) => { const d = (v || '').replace(/\D/g, ''); return d.length >= 7 ? d.slice(-10) : null; };

/** Pura: dados los registros, devuelve id -> {modulo, ya, m} de lo que tiene que estar bloqueado. */
export function calcularBloqueos(cuentas, contactos, tratos) {
  const usos = new Map();
  const sumar = (k, id) => { if (!k) return; if (!usos.has(k)) usos.set(k, new Set()); usos.get(k).add(id); };
  for (const a of cuentas) { sumar(mail(a.Correo_electr_nico), a.id); sumar(tel(a.Phone), a.id); }
  for (const c of contactos) { sumar(mail(c.Email), c.id); sumar(tel(c.Mobile), c.id); sumar(tel(c.Phone), c.id); }
  const repetido = (k) => k && !EXCEPCIONES.has(k) && usos.get(k).size > LIMITE;

  // 11-nov-2026 (Ignacio: "abotax fixcal globo y ellos no tienen que llegar"): la cuenta y el contacto
  // de un trato con Partner ≠ Start Companies, o de un contacto con Nombre_de_Partner de un socio
  // empresa, también son clientes de socio aunque la cuenta no tenga Socio cargado. Antes solo se
  // bloqueaba el trato. Los referidores INDIVIDUALES (Roger, etc.) NO: a sus referidos sí se les escribe.
  const partnerDe = (d) => d.Partner && d.Partner !== 'Start Companies';
  const cuentaPartner = new Map(), contactoPartner = new Map();
  for (const d of tratos) if (partnerDe(d)) {
    if (d.Account_Name?.id) cuentaPartner.set(d.Account_Name.id, d.Partner);
    if (d.Contact_Name?.id) contactoPartner.set(d.Contact_Name.id, d.Partner);
  }
  for (const c of contactos) { const n = String(c.Nombre_de_Partner?.name || c.Nombre_de_Partner || ''); if (SOCIOS_EMPRESA.test(n)) { contactoPartner.set(c.id, n); if (c.Account_Name?.id) cuentaPartner.set(c.Account_Name.id, n); } }
  const motivo = new Map();
  const cuentaBloq = new Set();
  for (const a of cuentas) {
    let m = null;
    if (INTERNOS.test(a.Account_Name || '')) continue;
    if (a.Socio) m = `socio ${a.Socio.name || ''}`.trim();
    else if (cuentaPartner.has(a.id)) m = `cliente de socio ${cuentaPartner.get(a.id)}`;
    else if (!EXCEPCIONES.has(mail(a.Correo_electr_nico)) && (repetido(mail(a.Correo_electr_nico)) || repetido(tel(a.Phone)))) m = 'mail/telefono repetido';
    if (m) { cuentaBloq.add(a.id); motivo.set(a.id, { modulo: 'Accounts', ya: !!a.Bloqueo_de_envio, m }); }
  }
  const contactoBloq = new Set();
  for (const c of contactos) {
    let m = null;
    if (INTERNOS.test(c.Full_Name || '')) continue;
    if (c.Account_Name && cuentaBloq.has(c.Account_Name.id)) m = 'cuenta bloqueada';
    else if (contactoPartner.has(c.id)) m = `cliente de socio ${contactoPartner.get(c.id)}`;
    else if (!EXCEPCIONES.has(mail(c.Email)) && (repetido(mail(c.Email)) || repetido(tel(c.Mobile)) || repetido(tel(c.Phone)))) m = 'mail/telefono repetido';
    if (m) { contactoBloq.add(c.id); motivo.set(c.id, { modulo: 'Contacts', ya: !!c.Bloqueo_de_envio, m }); }
  }
  for (const d of tratos) {
    let m = null;
    if (d.Partner && d.Partner !== 'Start Companies') m = `partner ${d.Partner}`;
    else if (d.Account_Name && cuentaBloq.has(d.Account_Name.id)) m = 'cuenta bloqueada';
    else if (d.Contact_Name && contactoBloq.has(d.Contact_Name.id)) m = 'contacto bloqueado';
    if (m) motivo.set(d.id, { modulo: 'Deals', ya: !!d.Bloqueo_de_envio, m });
  }
  return motivo;
}

/** Una pasada: lee todo, tilda lo que falta. Devuelve un resumen. */
export async function pasadaBloqueo({ aplicar = true } = {}) {
  const cuentas = await paginado('Accounts', 'Account_Name,Correo_electr_nico,Phone,Socio,Bloqueo_de_envio');
  const contactos = await paginado('Contacts', 'Full_Name,Email,Mobile,Phone,Account_Name,Bloqueo_de_envio,Nombre_de_Partner');
  const tratos = await paginado('Deals', 'Deal_Name,Account_Name,Contact_Name,Partner,Bloqueo_de_envio');
  const nombre = new Map();
  for (const a of cuentas) nombre.set(a.id, a.Account_Name || '');
  for (const c of contactos) nombre.set(c.id, c.Full_Name || '');
  for (const d of tratos) nombre.set(d.id, d.Deal_Name || '');

  const motivo = calcularBloqueos(cuentas, contactos, tratos);
  const pendientes = [...motivo].filter(([, v]) => !v.ya);
  const res = { leidos: { cuentas: cuentas.length, contactos: contactos.length, tratos: tratos.length }, pendientes: pendientes.length, tildados: 0, errores: 0, detalle: [] };
  for (const [id, v] of pendientes) res.detalle.push(`${v.modulo} · ${nombre.get(id) || id} · ${v.m}`);
  if (!aplicar || !pendientes.length) return res;

  const token = await tokenActual();
  for (const modulo of ['Accounts', 'Contacts', 'Deals']) {
    const ids = pendientes.filter(([, v]) => v.modulo === modulo).map(([id]) => id);
    for (let i = 0; i < ids.length; i += 100) {
      const r = await fetch(`https://www.zohoapis.com/crm/v6/${modulo}`, {
        method: 'PUT',
        headers: { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: ids.slice(i, i + 100).map((id) => ({ id, Bloqueo_de_envio: true })), trigger: [] }),
      });
      const j = await r.json();
      for (const x of j.data || []) x.status === 'success' ? res.tildados++ : res.errores++;
    }
  }
  return res;
}
