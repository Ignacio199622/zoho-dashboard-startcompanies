/*
 * Renovaciones ESTATALES (Annual Report, franchise tax), sin red.
 *
 * POR QUE EXISTE: el 29-oct-2026 GloboBanks reclamo dos Annual Reports de
 * Wyoming que se habian pasado (BYHUMANS TECH vencido el 1-oct, AMURA el 1-nov).
 * En Zoho no salto nada porque la funcion sc_autocompletar_renovacion le pone
 * 2027 a todas las LLCs: el vencimiento 2026 no existia en ningun lado.
 *
 * Aca la fecha NO sale de Zoho: se calcula con la regla de cada estado a partir
 * de la fecha de constitucion. Zoho solo guarda el tilde:
 *   - LLC.ltima_renovaci_n_estatal  (fecha en que se presento)
 *   - o, para el ciclo 2026, Renovaci_n_estatal = Sí / No corresponde en el
 *     trato de renovacion (lo que ya cargaba el equipo en la planilla).
 *
 * QUIEN ENTRA (Ignacio, 29-oct): solo la LLC que RENOVO CON NOSOTROS ese año,
 * o sea la que tiene trato de Renovacion de ese año (propia, de partner o por
 * transicion). Si abrio en mayo y no renovo en abril, no hacemos nada. El
 * estatal de ese año queda pendiente aunque la federal siga colgada: el caso
 * tipico es el partner que paso los datos, se renovo y el Annual Report quedo.
 * El año del trato sale de Created_Time. Nuevo Mexico no tiene Annual Report.
 */

const DIA = 864e5;
// Se avisa cuando ABRE la ventana del estado, no antes: la federal se presenta
// en marzo y en Wyoming el Annual Report recien se puede presentar unos meses
// antes del mes aniversario (Ignacio: "una ventana de 3 meses"). Los demas
// estados abren el 1-ene y se presentan junto con la federal.
export const VENTANA_WY_MESES = 3;

// vence: vencimiento del año y. abre: desde cuando se puede presentar.
const REGLAS = {
  Wyoming: { vence: (c, y) => Date.UTC(y, c.getUTCMonth(), 1), abre: (c, y) => Date.UTC(y, c.getUTCMonth() - VENTANA_WY_MESES, 1) }, // 1ro del mes aniversario
  Delaware: { vence: (c, y) => Date.UTC(y, 5, 1), abre: (c, y) => Date.UTC(y, 0, 1) },     // 1-jun, tax anual LLC
  Florida: { vence: (c, y) => Date.UTC(y, 4, 1), abre: (c, y) => Date.UTC(y, 0, 1) },      // 1-may, Annual Report
  Texas: { vence: (c, y) => Date.UTC(y, 4, 15), abre: (c, y) => Date.UTC(y, 0, 1) },       // 15-may, franchise tax + PIR
  California: { vence: (c, y) => Date.UTC(y, 3, 15), abre: (c, y) => Date.UTC(y, 0, 1) }, // 15-abr, tax de 800
};
export const ESTADOS_CON_REGLA = Object.keys(REGLAS);
const SIN_REPORTE = new Set(['New Mexico']);

const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const nombre = (v) => (v && typeof v === 'object' ? String(v.name || '') : String(v || ''));

const anioTrato = (t) => (t.Created_Time ? Number(t.Created_Time.slice(0, 4)) : 2026);

// El ciclo vigente: el primer vencimiento no confirmado de un año que renovo con nosotros.
function ciclo(llc, tratos, hoy) {
  const regla = REGLAS[llc.Estado_de_Registro];
  if (!regla || !llc.Fecha_de_Constituci_n) return null;
  const c = new Date(llc.Fecha_de_Constituci_n);
  const ultima = llc.ltima_renovaci_n_estatal ? Date.parse(llc.ltima_renovaci_n_estatal) : null;
  const anios = [...new Set(tratos.map(anioTrato))].filter((y) => y > c.getUTCFullYear()).sort();

  for (const y of anios) {
    const vence = regla.vence(c, y), abre = regla.abre(c, y);
    const marca = tratos.filter((t) => anioTrato(t) === y).some((t) => t.Renovaci_n_estatal === 'Sí' || t.Renovaci_n_estatal === 'No corresponde');
    // Se puede presentar unos meses antes: cuenta desde 5 meses previos.
    const confirmado = (ultima && ultima >= vence - 150 * DIA) || marca;
    if (!confirmado) {
      const dias = Math.round((vence - hoy) / DIA);
      return { anio: y, vence: iso(vence), dias, abre: iso(abre), estado: dias < 0 ? 'Vencida' : hoy >= abre ? 'Presentar ya' : 'Esperando ventana' };
    }
  }
  return null;
}

/**
 * Arma una fila por LLC que nos toca renovar en el estado.
 * @param {object[]} llcs   Accounts con Estado_de_Registro, Fecha_de_Constituci_n,
 *                          ltima_renovaci_n_estatal, Socio, Status
 * @param {object[]} tratos Deals (se usan los Type = Renovación)
 */
export function filasEstatales(llcs, tratos, hoy = Date.now()) {
  const renov = new Map();
  for (const t of tratos) {
    if (t.Type !== 'Renovación' || !t.Account_Name?.id) continue;
    if (!renov.has(t.Account_Name.id)) renov.set(t.Account_Name.id, []);
    renov.get(t.Account_Name.id).push(t);
  }
  const filas = [];
  for (const a of llcs) {
    const estado = a.Estado_de_Registro || '';
    if (!estado || SIN_REPORTE.has(estado) || /cerrad/i.test(a.Status || '')) continue;
    const ts = renov.get(a.id) || [];
    if (!ts.length) continue;   // no renovo con nosotros: no nos toca
    const transicion = ts.some((t) => /transici/i.test(t.Origen_del_trato || ''));
    const motivo = transicion ? 'Transición' : `Renovó ${[...new Set(ts.map(anioTrato))].join('/')}`;

    const c = ciclo(a, ts, hoy);
    if (!REGLAS[estado]) {
      filas.push(base(a, ts, motivo, { anio: null, vence: '', dias: null, estado: 'Revisar a mano' }));
    } else if (c) {
      filas.push(base(a, ts, motivo, c));
    } else {
      filas.push(base(a, ts, motivo, { anio: null, vence: '', dias: null, estado: 'Al día' }));
    }
  }
  return filas.sort((x, y) => (x.dias ?? 1e9) - (y.dias ?? 1e9));
}

function base(a, ts, motivo, c) {
  return {
    id: a.id,
    llc: a.Account_Name || '',
    estado: a.Estado_de_Registro || '',
    socio: nombre(a.Socio) || 'Propia',
    constituida: a.Fecha_de_Constituci_n || '',
    motivo,
    anio: c.anio,
    abre: c.abre || '',
    vence: c.vence,
    dias: c.dias,
    alerta: c.estado,
    ultima: a.ltima_renovaci_n_estatal || '',
    tratoId: ts[0]?.id || '',
    marca: '',   // lo que el equipo elige en la planilla
  };
}

// Lo que va en el aviso: vencidas y las que ya tienen la ventana abierta.
export const pendientesDeAviso = (filas) => filas.filter((f) => f.alerta === 'Vencida' || f.alerta === 'Presentar ya');

export function armarAviso(filas, link) {
  const p = pendientesDeAviso(filas);
  if (!p.length) return null;
  const zoho = (f) => `<https://crm.zoho.com/crm/org881745849/tab/Accounts/${f.id}|${f.llc}>`;
  const linea = (f) => `• ${zoho(f)} · ${f.estado} · ${f.socio} · vence ${f.vence}${f.dias < 0 ? ` (*hace ${-f.dias} días*)` : ` (en ${f.dias} días)`}`;
  const venc = p.filter((f) => f.alerta === 'Vencida');
  const prox = p.filter((f) => f.alerta === 'Presentar ya');
  const porEstado = (lista) => [...new Set(lista.map((f) => f.estado))].map((e) => `${e} ${lista.filter((f) => f.estado === e).length}`).join(' · ');

  // Un mensaje de resumen y despues uno por bloque, cortados antes del limite
  // de Slack: una sola pared de 200 lineas no la lee nadie.
  const mensajes = [[
    `*Renovaciones estatales pendientes: ${p.length}*`,
    venc.length ? `🔴 Vencidas sin confirmar: *${venc.length}* (${porEstado(venc)})` : null,
    prox.length ? `🟡 Ya se pueden presentar: *${prox.length}* (${porEstado(prox)})` : null,
    `Cuando la presenten (o si ya estaba presentada), márquenla en la <${link}|planilla, pestaña Estatales>. Lo que no se marque vuelve a aparecer el lunes.`,
  ].filter(Boolean).join('\n')];
  const bloque = (titulo, lista) => {
    let actual = titulo;
    for (const f of lista) {
      const l = linea(f);
      if (actual.length + l.length > 3500) { mensajes.push(actual); actual = `${titulo} (sigue)`; }
      actual += `\n${l}`;
    }
    mensajes.push(actual);
  };
  if (prox.length) bloque('*🟡 Ya se pueden presentar*', prox);
  if (venc.length) bloque('*🔴 Vencidas sin confirmar*', venc);
  return { mensajes, vencidas: venc.length, proximas: prox.length };
}

/**
 * La fecha estatal correcta para Zoho (Accounts.Fecha_renovaci_n_estatal).
 *
 * La regla de Zoho sc_autocompletar_renovacion la llena una sola vez con "la proxima
 * fecha desde hoy": las vencidas saltan al año siguiente (2027) y nunca se ven atrasadas,
 * y el panel muestra esa fecha. Aca se pisa con el vencimiento pendiente real de cada
 * LLC que renueva con nosotros (puede estar en el pasado = vencida). Solo devuelve las
 * que cambian. Las "Al dia" y "Revisar a mano" no se tocan.
 */
export function fechasParaZoho(filas, llcs) {
  const actual = new Map(llcs.map((a) => [a.id, String(a.Fecha_renovaci_n_estatal || '').slice(0, 10)]));
  return filas
    .filter((f) => f.vence && actual.get(f.id) !== f.vence)
    .map((f) => ({ id: f.id, Fecha_renovaci_n_estatal: f.vence }));
}
