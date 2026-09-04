// Las reglas de Control CRM. Cada una devuelve lo que esta mal HOY y, cuando
// hay foto anterior, lo que aparecio DESDE la ultima corrida.
//
// Todo es lectura. Ninguna regla escribe en Zoho.
import { paginado } from './zoho.js';

const ZOHO_UI = 'https://crm.zoho.com/crm/tab';
export const link = (modulo, id) => `${ZOHO_UI}/${modulo}/${id}`;

const normTel = (t) => String(t || '').replace(/\D/g, '').slice(-10);
const dias = (d) => (Date.now() - new Date(d)) / 864e5;
const vacio = (v) => v === null || v === undefined || v === '';

// Regla 8: cuantos dias de historia se miran para saber el ritmo de un canal, y
// cuantos leads tiene que haber traido en esos dias para que valga la pena
// vigilarlo. Debajo de eso el promedio no dice nada y solo hace ruido.
const VENTANA = 28;
const MINIMO_CANAL = 10;

// Regla 9: cuantas horas puede quedarse quieto un lead de Meta antes de avisar.
// Seis encaja con los dos avisos: el que carga el formulario a la manana sale en
// el de las 16:30 del mismo dia, y el de la tarde o la noche en el de las 9:00.
// Con doce, el de la manana se perdia el aviso de la tarde y dormia hasta el
// otro dia, que es justo lo que hay que evitar con un lead recien entrado.
const HORAS_SIN_CONTACTO = 6;

// Regla 10: desde cuando y hasta cuando se considera "no salio". Arriba de 30
// dias ya lo cuenta la regla 7 como stock viejo abandonado; entre 1 y 30 es la
// falla de esta semana, la que todavia se puede destrabar.
const FALLA_DESDE = 1;
const FALLA_HASTA = 30;

const SINGLE = /single|un solo miembro|unipersonale/i;
const MULTI = /multi|m.ltiples/i;
const FASES_CERRADAS = new Set([
  'Apertura Activa', 'Apertura Perdida', 'Cuenta Bancaria Finalizada',
  'Cuenta Bancaria Perdida', 'Renovación completa',
]);

/** Baja del CRM todo lo que necesitan las reglas, una sola vez. */
export async function leerCrm() {
  const leads = await paginado('Leads',
    'id,Full_Name,Email,Phone,Mobile,Lead_Status,Lead_Source,Owner,Retargeting,Fecha_Siguiente_Mensaje,Created_Time,'
    + 'Nombre_retargeting,N_mero_de_mensaje,Last_Activity_Time,leadchain0__Social_Lead_ID');
  const contactos = await paginado('Contacts', 'id,Full_Name,Email,Phone,Mobile,Account_Name,Tipo_de_Contacto');
  const llcs = await paginado('Accounts', 'id,Account_Name,Estructura_Societaria,Estado_de_Registro,Owner,Created_Time');
  const tratos = await paginado('Deals', 'id,Deal_Name,Account_Name,Type,Stage,Amount,Owner,Created_Time,Modified_Time');
  const props = await paginado('Propietarios_LLC', 'id,Name,LLC,Created_Time');
  const events = await paginado('Events', 'id,Event_Title,Start_DateTime,What_Id,Who_Id,Status_del_Meet,Owner');
  return { leads, contactos, llcs, tratos, props, events };
}

/**
 * Las siete reglas. Cada una devuelve:
 *   clave    id corto para comparar contra la corrida anterior
 *   titulo   como se lee en Slack
 *   nivel    'alto' | 'medio'
 *   casos    [{ id, texto, link, creado }]
 */
export function evaluar({ leads, contactos, llcs, tratos, props, events }) {
  const reglas = [];

  // 1. Dos posibles clientes con el mismo telefono.
  const porTel = new Map();
  for (const l of leads) {
    const t = normTel(l.Mobile || l.Phone);
    if (!t) continue;
    (porTel.get(t) || porTel.set(t, []).get(t)).push(l);
  }
  reglas.push({
    clave: 'duplicados',
    titulo: 'posibles clientes duplicados',
    nivel: 'alto',
    casos: [...porTel.entries()].filter(([, v]) => v.length > 1).map(([tel, v]) => {
      const orden = [...v].sort((a, b) => new Date(b.Created_Time) - new Date(a.Created_Time));
      return {
        id: `tel:${tel}`,
        texto: `${orden[0].Full_Name || 'sin nombre'} · ${orden.map((x) => x.Lead_Source || 'sin canal').join(' / ')}`,
        link: link('Leads', orden[0].id),
        creado: orden[0].Created_Time,
      };
    }),
  });

  // 2. Se abrio un lead de alguien que ya es cliente: arranca cadencia de captacion.
  const telContactos = new Map();
  for (const c of contactos) {
    const t = normTel(c.Mobile || c.Phone);
    if (t) telContactos.set(t, c);
  }
  reglas.push({
    clave: 'lead-de-cliente',
    titulo: 'posibles clientes que ya son clientes',
    nivel: 'alto',
    casos: leads.filter((l) => telContactos.has(normTel(l.Mobile || l.Phone))).map((l) => ({
      id: `lc:${l.id}`,
      texto: `${l.Full_Name || 'sin nombre'} · ya existe como contacto`,
      link: link('Leads', l.id),
      creado: l.Created_Time,
    })),
  });

  // 3. LLC sin ninguna ficha de propietario.
  const conProp = new Set(props.map((p) => p.LLC?.id).filter(Boolean));
  reglas.push({
    clave: 'llc-sin-propietario',
    titulo: 'LLCs sin propietario cargado',
    nivel: 'medio',
    casos: llcs.filter((a) => !conProp.has(a.id)).map((a) => ({
      id: `sp:${a.id}`,
      texto: `${a.Account_Name} · ${a.Estado_de_Registro || 'sin estado'}`,
      link: link('Accounts', a.id),
      creado: a.Created_Time,
    })),
  });

  // 4. La estructura societaria no coincide con los socios cargados. Importa
  //    porque de ese campo sale la fecha de renovacion federal.
  const cuentaProp = new Map();
  for (const p of props) {
    const id = p.LLC?.id;
    if (id) cuentaProp.set(id, (cuentaProp.get(id) || 0) + 1);
  }
  reglas.push({
    clave: 'estructura',
    titulo: 'estructura societaria que no coincide',
    nivel: 'medio',
    casos: llcs.filter((a) => {
      const n = cuentaProp.get(a.id) || 0;
      if (!n) return false;
      const es = String(a.Estructura_Societaria || '');
      return (MULTI.test(es) && n === 1) || (SINGLE.test(es) && n > 1);
    }).map((a) => ({
      id: `es:${a.id}`,
      texto: `${a.Account_Name} · dice ${MULTI.test(a.Estructura_Societaria) ? 'multi' : 'single'} y tiene ${cuentaProp.get(a.id)} socio(s)`,
      link: link('Accounts', a.id),
      creado: a.Created_Time,
    })),
  });

  // 5. Reunion que ya paso y nadie marco si la persona vino.
  reglas.push({
    clave: 'reuniones-sin-marcar',
    titulo: 'reuniones sin marcar si vino',
    nivel: 'medio',
    casos: events.filter((e) => e.Start_DateTime && dias(e.Start_DateTime) > 2 && vacio(e.Status_del_Meet)).map((e) => ({
      id: `rm:${e.id}`,
      texto: `${e.Event_Title || 'sin título'} · ${String(e.Start_DateTime).slice(0, 10)} · ${e.Owner?.name || 'sin dueño'}`,
      link: link('Events', e.id),
      creado: e.Start_DateTime,
      duenio: e.Owner?.name || null,
    })),
  });

  // 6. Trato abierto que no se mueve.
  reglas.push({
    clave: 'tratos-frenados',
    titulo: 'tratos abiertos frenados +90 días',
    nivel: 'medio',
    casos: tratos.filter((d) => !FASES_CERRADAS.has(d.Stage) && dias(d.Modified_Time) > 90).map((d) => ({
      id: `tf:${d.id}`,
      texto: `${d.Deal_Name} · ${d.Stage} · ${Math.round(dias(d.Modified_Time))} días sin moverse`,
      link: link('Deals', d.id),
      creado: d.Modified_Time,
      duenio: d.Owner?.name || null,
    })),
  });

  // 7. Cadencia prendida con el mensaje vencido. Es el patron del bloqueo de
  //    WhatsApp: si algo lee el flag, los despierta a todos juntos.
  reglas.push({
    clave: 'cadencias-vencidas',
    titulo: 'cadencias vencidas con el flag prendido',
    nivel: 'alto',
    casos: leads.filter((l) =>
      l.Retargeting === true && l.Fecha_Siguiente_Mensaje && dias(l.Fecha_Siguiente_Mensaje) > 30
    ).map((l) => ({
      id: `cv:${l.id}`,
      texto: `${l.Full_Name || 'sin nombre'} · ${l.Lead_Status} · vencido hace ${Math.round(dias(l.Fecha_Siguiente_Mensaje))} días`,
      link: link('Leads', l.id),
      creado: l.Fecha_Siguiente_Mensaje,
    })),
  });

  // 8. Un canal que venia trayendo leads todos los dias dejo de traer.
  //    Asi se ve desde el CRM que se corto una integracion, sin llamar a Meta.
  //    El 3-sep-2026 se descubrio a mano que 48 de 61 leads de los formularios
  //    de Meta nunca habian llegado: esta regla es para no volver a enterarse
  //    una semana tarde.
  //
  //    El umbral se calcula solo con el ritmo de cada canal en los ultimos 28
  //    dias: un canal que trae 2 por dia se avisa a las 48 h de silencio, uno
  //    que trae 1 cada 3 dias recien a los 12. Asi no hay que mantener una
  //    lista de canales ni un numero fijo por canal.
  const ahora = Date.now();
  const ritmo = new Map();
  for (const l of leads) {
    if (!l.Created_Time || !l.Lead_Source) continue;
    const t = new Date(l.Created_Time).getTime();
    if (ahora - t > VENTANA * 864e5) continue;
    const v = ritmo.get(l.Lead_Source) || { n: 0, ultimo: 0 };
    v.n++;
    v.ultimo = Math.max(v.ultimo, t);
    ritmo.set(l.Lead_Source, v);
  }
  reglas.push({
    clave: 'canal-sin-leads',
    titulo: 'canales que dejaron de traer leads',
    nivel: 'alto',
    casos: [...ritmo.entries()].filter(([, v]) => v.n >= MINIMO_CANAL).map(([fuente, v]) => {
      const porDia = v.n / VENTANA;
      const umbral = Math.max(24, 4 * (24 / porDia));   // horas
      const silencio = (ahora - v.ultimo) / 36e5;
      return { fuente, porDia, umbral, silencio, ultimo: new Date(v.ultimo).toISOString() };
    }).filter((c) => c.silencio > c.umbral).map((c) => ({
      id: `pulso:${c.fuente}`,
      texto: `${c.fuente} · sin leads nuevos hace ${Math.round(c.silencio)} h · venía trayendo ${c.porDia.toFixed(1)} por día`,
      link: `${ZOHO_UI}/Leads`,
      creado: c.ultimo,
    })),
  });

  // 9. Lead de Meta que entro y nadie toco. Los que recupera la sincronizacion
  //    de Lead Chain entran crudos: estado `Nuevo MQL`, sin cadencia, sin
  //    fecha de proximo mensaje. Eso es bueno (no dispara WhatsApp masivo) y
  //    peligroso: si nadie los reparte se quedan ahi. Son justo los que ventas
  //    tiene que llamar en caliente.
  reglas.push({
    clave: 'meta-sin-contactar',
    titulo: 'leads de Meta que nadie contactó',
    nivel: 'alto',
    casos: leads.filter((l) =>
      l.leadchain0__Social_Lead_ID
      && vacio(l.Nombre_retargeting)
      && dias(l.Created_Time) * 24 > HORAS_SIN_CONTACTO
      // Sin actividad posterior a la creacion: nadie lo abrio, ni le escribio,
      // ni le cambio el estado. Zoho toca Last_Activity_Time con cualquiera de
      // esas tres cosas, asi que alcanza para saber si esta virgen.
      && (!l.Last_Activity_Time || new Date(l.Last_Activity_Time) - new Date(l.Created_Time) < 5 * 60e3)
    ).map((l) => ({
      id: `msc:${l.id}`,
      texto: `${l.Full_Name || 'sin nombre'} · ${l.Mobile || l.Phone || 'sin teléfono'} · entró hace ${Math.round(dias(l.Created_Time) * 24)} h y sigue en ${l.Lead_Status || 'sin estado'}`,
      link: link('Leads', l.id),
      creado: l.Created_Time,
    })),
  });

  // 10. El mensaje tenia fecha para salir, la fecha paso y sigue sin salir.
  //     Es la falla del motor de cadencia, no el stock viejo: eso lo cuenta la
  //     regla 7 (+30 dias). Aca esta lo que todavia se puede destrabar.
  reglas.push({
    clave: 'mensajes-que-no-salieron',
    titulo: 'mensajes de cadencia que no salieron',
    nivel: 'alto',
    casos: leads.filter((l) =>
      l.Retargeting === true && l.Fecha_Siguiente_Mensaje
      && dias(l.Fecha_Siguiente_Mensaje) > FALLA_DESDE
      && dias(l.Fecha_Siguiente_Mensaje) <= FALLA_HASTA
    ).map((l) => ({
      id: `mns:${l.id}`,
      texto: `${l.Full_Name || 'sin nombre'} · ${l.Nombre_retargeting || 'sin cadencia'} · mensaje ${l.N_mero_de_mensaje ?? '?'} · debía salir hace ${Math.round(dias(l.Fecha_Siguiente_Mensaje))} días`,
      link: link('Leads', l.id),
      creado: l.Fecha_Siguiente_Mensaje,
    })),
  });

  return reglas;
}

/**
 * En que fase esta cada cadencia. No es una regla: no hay nada que arreglar de
 * a un lead, es la foto de como viene el motor. Va al pie del aviso de las 9:00.
 *
 * Devuelve una fila por cadencia con el total, los dos mensajes donde se
 * amontona la gente y cuantos tienen el proximo envio vencido esta semana.
 */
export function mapaCadencias(leads) {
  const activos = leads.filter((l) => l.Retargeting === true);
  const porCadencia = new Map();
  for (const l of activos) {
    const c = l.Nombre_retargeting || 'con el flag prendido y sin cadencia';
    const v = porCadencia.get(c) || { total: 0, mensajes: new Map(), vencidos: 0 };
    v.total++;
    const m = l.N_mero_de_mensaje ?? '?';
    v.mensajes.set(m, (v.mensajes.get(m) || 0) + 1);
    if (l.Fecha_Siguiente_Mensaje && dias(l.Fecha_Siguiente_Mensaje) > 1 && dias(l.Fecha_Siguiente_Mensaje) <= 7) v.vencidos++;
    porCadencia.set(c, v);
  }
  return {
    activos: activos.length,
    total: leads.length,
    filas: [...porCadencia.entries()]
      .map(([cadencia, v]) => ({
        cadencia,
        total: v.total,
        vencidos: v.vencidos,
        picos: [...v.mensajes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2)
          .map(([m, n]) => ({ mensaje: m, cuantos: n })),
      }))
      .sort((a, b) => b.total - a.total),
  };
}

/** Que apareció y que se resolvio desde la foto anterior. */
export function comparar(reglas, anterior) {
  return reglas.map((r) => {
    const antes = new Set(anterior?.[r.clave] || []);
    const ahora = r.casos.map((c) => c.id);
    const hayFoto = !!anterior?.[r.clave];
    return {
      ...r,
      total: r.casos.length,
      nuevos: hayFoto ? r.casos.filter((c) => !antes.has(c.id)) : [],
      resueltos: hayFoto ? [...antes].filter((id) => !ahora.includes(id)).length : 0,
      primeraVez: !hayFoto,
    };
  });
}

export const fotoDe = (reglas) =>
  Object.fromEntries(reglas.map((r) => [r.clave, r.casos.map((c) => c.id)]));
