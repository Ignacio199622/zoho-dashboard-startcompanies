// Prueba las decisiones de la guardia fuera de horario (2-nov-2026).
// Sin red, sin Zoho, sin WhatsApp: solo las decisiones. `node scripts/test-guardia.mjs`
import assert from 'node:assert/strict';
import {
  opcionesGuardia, feriadosDeTexto, fichaParaCandado, motivoSocio, tipoPersona, decidirAviso,
  husoDelContacto, habilEn, vueltaEnSuHora, podarAvisos, clavesAviso, ultimoAvisoDe, TZ_AR,
} from '../netlify/functions/lib/conversaciones/guardia-filtros.js';
import { paraAvisar } from '../netlify/functions/lib/conversaciones/guardia.js';

let ok = 0;
const caso = (nombre, fn) => { fn(); ok++; console.log(`✓ ${nombre}`); };
const tags = (...n) => n.map((name) => ({ name }));

// Lunes 2-nov-2026 23:00 AR (02:00Z del martes): cerrado.
const NOCHE = new Date('2026-11-03T02:00:00Z');
const OPC = opcionesGuardia({});
// Cliente normal al que le corresponde el aviso.
const base = {
  tipo: 'cliente', motivoSocio: '', atendida: false, enCadencia: false, tieneReunion: false,
  otroNumero: false, cerro: false, ultimoAviso: null, habilContacto: false, camposListos: true, secuenciaViva: true,
};

// ─── Opciones (valores por defecto seguros) ─────────────────────────────────
caso('por defecto: candado de socio prendido', () => assert.equal(OPC.candadoSocio, true));
caso('por defecto: posible partner sin cadencia', () => assert.equal(OPC.posiblePartnerSinCadencia, true));
caso('por defecto: 15 minutos sin respuesta (lo de hoy)', () => assert.equal(OPC.minSinRespuesta, 15));
caso('por defecto: 12 h entre avisos', () => assert.equal(OPC.horasEntreAvisos, 12));
caso('por defecto: huso del contacto apagado', () => assert.equal(OPC.tzContacto, false));
caso('GUARDIA_CANDADO_SOCIO=0 lo apaga', () => assert.equal(opcionesGuardia({ GUARDIA_CANDADO_SOCIO: '0' }).candadoSocio, false));
caso('GUARDIA_MIN_SIN_RESPUESTA=30', () => assert.equal(opcionesGuardia({ GUARDIA_MIN_SIN_RESPUESTA: '30' }).minSinRespuesta, 30));
caso('GUARDIA_MIN_SIN_RESPUESTA basura: queda 15', () => assert.equal(opcionesGuardia({ GUARDIA_MIN_SIN_RESPUESTA: 'x' }).minSinRespuesta, 15));
caso('GUARDIA_FERIADOS: descarta lo que no es fecha', () => assert.deepEqual(feriadosDeTexto('2026-12-24, nada ,2026-12-31'), ['2026-12-24', '2026-12-31']));

// ─── Candado de socio sobre la ficha del contacto ───────────────────────────
const maglia = { id: '1', Full_Name: 'Matteo Maglia', Tipo_de_Contacto: 'Partner', Nombre_de_Partner: 'Globo Bank', Bloqueo_de_envio: true, Account_Name: { id: 'a' } };
const weill = { id: '2', Full_Name: 'Giancarlos Weill', Tipo_de_Contacto: 'Partner', Bloqueo_de_envio: false };
const clienteSocio = { id: '3', Full_Name: 'X', Tipo_de_Contacto: 'Cliente', Bloqueo_de_envio: false };
const clienteNuestro = { id: '4', Full_Name: 'Luciana Heredia', Tipo_de_Contacto: 'Cliente', Bloqueo_de_envio: false };
caso('Maglia (Bloqueo + Globo): socio', () => assert.match(motivoSocio('Contacts', maglia, { Socio: { name: 'Globo Banks' } }), /Bloqueo/));
caso('Weill (Tipo de contacto Partner): socio', () => assert.match(motivoSocio('Contacts', weill, null), /partner/));
caso('cliente con LLC de socio (Account_Name.Socio): socio', () => assert.match(motivoSocio('Contacts', clienteSocio, { Socio: { name: 'Tax Solutions' } }), /Tax Solutions/));
caso('LLC con Bloqueo_de_envio: socio', () => assert.match(motivoSocio('Contacts', clienteNuestro, { Bloqueo_de_envio: true }), /Bloqueo/));
caso('Nombre_de_Partner "Start Companies": no frena', () => assert.equal(motivoSocio('Contacts', { ...clienteNuestro, Nombre_de_Partner: 'Start Companies' }, null), ''));
caso('cliente nuestro: no frena', () => assert.equal(motivoSocio('Contacts', clienteNuestro, { Socio: null }), ''));
caso('fichaParaCandado copia Socio de la LLC', () => assert.equal(fichaParaCandado(clienteNuestro, { Socio: { name: 'S' } }).Socio.name, 'S'));

// ─── Tipo de persona ────────────────────────────────────────────────────────
caso('contacto: cliente', () => assert.equal(tipoPersona('Contacts', clienteNuestro, ''), 'cliente'));
caso('contacto de socio: socio', () => assert.equal(tipoPersona('Contacts', maglia, 'Bloqueo'), 'socio'));
caso('lead normal: lead', () => assert.equal(tipoPersona('Leads', { Tipo: 'Apertura', Tag: tags('Form Nov Meta') }, ''), 'lead'));
caso('lead "Posible Partner": posible_partner', () => assert.equal(tipoPersona('Leads', { Tipo: 'Posible Partner' }, ''), 'posible_partner'));
caso('lead con etiqueta Form Socios Meta: posible_partner', () => assert.equal(tipoPersona('Leads', { Tag: tags('Form Socios Meta') }, ''), 'posible_partner'));
caso('lead con etiqueta "Socio Tax Solutions": socio', () => {
  const l = { Tag: tags('Socio Tax Solutions') };
  assert.equal(tipoPersona('Leads', l, motivoSocio('Leads', l)), 'socio');
});

// ─── La decision: una por motivo ────────────────────────────────────────────
const d = (extra, o = OPC, ahora = NOCHE) => decidirAviso({ ...base, ...extra }, o, ahora);
caso('cliente sin nada raro: AVISO', () => { const r = d({}); assert.equal(r.aviso, true); assert.equal(r.codigo, 'aviso'); assert.equal(r.secuencia, false); });
caso('cliente de socio: sin aviso, sin cadencia', () => { const r = d({ tipo: 'socio', motivoSocio: 'cliente del socio Globo' }); assert.equal(r.aviso, false); assert.equal(r.codigo, 'socio'); assert.equal(r.secuencia, false); });
caso('lead de socio: sin aviso y NO entra a Agendamiento', () => { const r = d({ tipo: 'socio', motivoSocio: 'etiqueta Socio X' }); assert.equal(r.secuencia, false); });
caso('lead: sin aviso, entra a Agendamiento', () => { const r = d({ tipo: 'lead' }); assert.equal(r.aviso, false); assert.equal(r.codigo, 'lead'); assert.equal(r.secuencia, true); });
caso('lead ya en cadencia: no se lo vuelve a meter', () => assert.equal(d({ tipo: 'lead', enCadencia: true }).secuencia, false));
caso('lead con reunion: no entra a Agendamiento', () => assert.equal(d({ tipo: 'lead', tieneReunion: true }).secuencia, false));
caso('lead con la regla de Agendamiento apagada: no entra', () => assert.equal(d({ tipo: 'lead', secuenciaViva: false }).secuencia, false));
caso('posible partner: sin aviso y sin cadencia de LLC', () => { const r = d({ tipo: 'posible_partner' }); assert.equal(r.aviso, false); assert.equal(r.secuencia, false); assert.match(r.motivo, /posible partner/); });
caso('posible partner con GUARDIA_POSIBLE_PARTNER=0: entra como hoy', () => assert.equal(d({ tipo: 'posible_partner' }, opcionesGuardia({ GUARDIA_POSIBLE_PARTNER: '0' })).secuencia, true));
caso('cliente nunca entra a Agendamiento', () => assert.equal(d({}).secuencia, false));
caso('atendido por el equipo: sin aviso', () => assert.equal(d({ atendida: true }).codigo, 'equipo'));
caso('en cadencia: sin aviso', () => assert.equal(d({ enCadencia: true }).codigo, 'cadencia'));
caso('con reunion: sin aviso', () => assert.equal(d({ tieneReunion: true }).codigo, 'reunion'));
caso('desde otro numero: sin aviso', () => assert.equal(d({ otroNumero: true }).codigo, 'otro_numero'));
caso('cerro con "gracias": sin aviso', () => assert.equal(d({ cerro: true }).codigo, 'cierre'));
caso('aviso hace 9 h: sin aviso (12 h)', () => assert.equal(d({ ultimoAviso: new Date(NOCHE - 9 * 3600e3).toISOString() }).codigo, 'reciente'));
caso('aviso hace 13 h: AVISO', () => assert.equal(d({ ultimoAviso: new Date(NOCHE - 13 * 3600e3).toISOString() }).aviso, true));
caso('GUARDIA_HORAS_ENTRE_AVISOS=0: no frena', () => assert.equal(d({ ultimoAviso: new Date(NOCHE - 3600e3).toISOString() }, opcionesGuardia({ GUARDIA_HORAS_ENTRE_AVISOS: '0' })).aviso, true));
caso('huso del contacto prendido y en su pais es horario habil: sin aviso', () => assert.equal(d({ habilContacto: true }, opcionesGuardia({ GUARDIA_TZ_CONTACTO: '1' })).codigo, 'su_horario'));
caso('huso del contacto apagado: no lo mira', () => assert.equal(d({ habilContacto: true }).aviso, true));
caso('faltan campos en Zoho: sin aviso', () => assert.equal(d({ camposListos: false }).codigo, 'sin_campos'));
caso('el socio gana a todo lo demas', () => assert.equal(d({ tipo: 'socio', motivoSocio: 'x', atendida: true, cerro: true }).codigo, 'socio'));

// ─── Huso del contacto ──────────────────────────────────────────────────────
caso('+52: Mexico', () => assert.equal(husoDelContacto({ telefono: '+5215512345678' }), 'America/Mexico_City'));
caso('+34: Madrid', () => assert.equal(husoDelContacto({ telefono: '34600111222' }), 'Europe/Madrid'));
caso('+598 gana a +59x: Montevideo', () => assert.equal(husoDelContacto({ telefono: '+59899111222' }), 'America/Montevideo'));
caso('+1809: Santo Domingo', () => assert.equal(husoDelContacto({ telefono: '+18095551234' }), 'America/Santo_Domingo'));
caso('+1 de EE.UU.: no se adivina', () => assert.equal(husoDelContacto({ telefono: '+13055551234' }), null));
caso('Codigo_de_Pais CO gana al telefono', () => assert.equal(husoDelContacto({ codigoPais: 'CO', telefono: '+5491112345678' }), 'America/Bogota'));
caso('Madrid 10:00 de un martes es habil', () => assert.equal(habilEn(new Date('2026-11-03T09:00:00Z'), 'Europe/Madrid'), true));
caso('Mexico 23:00 no es habil', () => assert.equal(habilEn(new Date('2026-11-03T05:00:00Z'), 'America/Mexico_City'), false));
caso('feriado de la lista: no es habil', () => assert.equal(habilEn(new Date('2026-11-26T15:00:00Z'), TZ_AR, new Set(['2026-11-26'])), false));
caso('vuelta en hora de Madrid: 9 AR = 13 Madrid', () => assert.equal(vueltaEnSuHora('mañana a las 9', '2026-11-03', 'Europe/Madrid'), 'mañana a las 13 (tu hora)'));
caso('vuelta en hora de Mexico: 9 AR = 6 CDMX', () => assert.equal(vueltaEnSuHora('mañana a las 9', '2026-11-03', 'America/Mexico_City'), 'mañana a las 6 (tu hora)'));
caso('vuelta en AR: igual', () => assert.equal(vueltaEnSuHora('mañana a las 9', '2026-11-03', TZ_AR), 'mañana a las 9'));

// ─── Memoria de 12 h ────────────────────────────────────────────────────────
caso('claves: ficha y ultimos 9 digitos', () => assert.deepEqual(clavesAviso('Contacts', '9', '+54 9 11 1234-5678'), ['Contacts:9', 'tel:112345678']));
caso('ultimo aviso por telefono aunque cambie la ficha', () => {
  const mem = { 'tel:112345678': '2026-11-02T20:00:00Z', 'Contacts:9': '2026-11-02T10:00:00Z' };
  assert.equal(ultimoAvisoDe(mem, clavesAviso('Contacts', '9', '+5491112345678')), '2026-11-02T20:00:00Z');
});
caso('podar: tira lo de mas de 12 h', () => assert.deepEqual(podarAvisos({ a: '2026-11-02T01:00:00Z', b: '2026-11-03T00:00:00Z' }, NOCHE, 12), { b: '2026-11-03T00:00:00Z' }));

// ─── Ultimo mensaje sin respuesta N minutos ─────────────────────────────────
const pend = (min) => ({ ref: `c${min}`, cuando: new Date(NOCHE - min * 60e3), minutosEsperando: min });
caso('15 min por defecto: el de 10 espera, el de 20 sale', () => {
  const { avisos } = paraAvisar([pend(10), pend(20)], NOCHE);
  assert.deepEqual(avisos.map((a) => a.ref), ['c20']);
});
caso('GUARDIA_MIN_SIN_RESPUESTA=30: el de 20 tambien espera', () => {
  const { avisos } = paraAvisar([pend(20), pend(40)], NOCHE, undefined, 30);
  assert.deepEqual(avisos.map((a) => a.ref), ['c40']);
});
caso('en horario no sale nada', () => {
  const martesMediodia = new Date('2026-11-03T15:00:00Z');
  assert.equal(paraAvisar([{ ...pend(60), cuando: new Date('2026-11-03T02:00:00Z') }], martesMediodia).avisos.length, 0);
});

// ─── PT/EN sin una sola palabra en español (11-nov-2026, Marcos de Lima) ───
// Recorre feriado, finde, madrugada, noche y viernes, con y sin pedido (CX).
{
  const { avisoEnIdioma, tieneIdioma } = await import('../netlify/functions/lib/conversaciones/guardia.js');
  // Palabras que son SOLO español (feriado, sábado, domingo también son portugués).
  const SOLO_ES = 'ya|terminamos|jornada|respondemos|jueves|miércoles|viernes|lunes|martes|escribí|consulta|acá|abajo|aunque|hayas|mañana|hoy|el|las|los|noviembre|diciembre|enero|hábil|está|equipo';
  const PROHIBIDO = {
    'Português': new RegExp(`(^|[^\\p{L}])(${SOLO_ES})(?![\\p{L}])`, 'iu'),
    English: new RegExp(`(^|[^\\p{L}])(${SOLO_ES}|feriado|sábado|domingo|hoje|amanhã|às|dia|útil|porque|não|novembro)(?![\\p{L}])`, 'iu'),
  };
  const momentos = [
    '2026-11-11T15:00:00Z', // miercoles feriado (Veterans Day), mediodia
    '2026-11-10T22:30:00Z', // martes 19:30, vispera de feriado
    '2026-11-14T15:00:00Z', // sabado
    '2026-11-12T10:00:00Z', // jueves 07:00, antes de abrir
    '2026-11-13T22:00:00Z', // viernes 19:00
    '2026-11-26T15:00:00Z', // Thanksgiving
  ];
  for (const idioma of ['Português', 'English']) {
    caso(`${idioma}: hay textos`, () => assert.equal(tieneIdioma(idioma), true));
    for (const m of momentos) {
      for (const conPedido of [false, true]) {
        caso(`${idioma} ${m} ${conPedido ? 'CX' : 'ventas'}: sin español`, () => {
          const r = avisoEnIdioma(idioma, new Date(m), { conPedido });
          const todo = `${r.porQue} | ${r.vuelta}`;
          assert.doesNotMatch(todo, PROHIBIDO[idioma], todo);
          assert.doesNotMatch(todo, /\n/, 'salto de linea: Meta rechaza la variable');
        });
      }
    }
  }
  caso('Español no se traduce (va la plantilla de siempre)', () => assert.equal(tieneIdioma('Español'), false));
}

console.log(`\n${ok} casos OK`);
