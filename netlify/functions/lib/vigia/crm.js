// CRM trabado. NO le pide nada a Zoho: lee lo que ya dejo Control CRM en su
// bitacora (store `control-crm`, clave `bitacora`). Control CRM baja ~16.000
// registros por corrida; repetir eso aca seria gastar cuota de Zoho para saber
// lo mismo.
//
// Tres cosas:
//   1. Si el propio Control CRM se cayo o dejo de correr (lo mas grave: el
//      vigilante del CRM mudo).
//   2. Lo que aparecio desde el cierre anterior (los "nuevos" de cada regla).
//   3. Lo que esta estancado: reglas con casos que no resolvieron ni uno en
//      los ultimos 3 cierres y no bajaron.

// Los titulos son los de lib/control-crm/reglas.js y puente.js. Si una regla
// nueva no esta aca, sale con su clave: feo pero no se pierde.
export const TITULOS = {
  duplicados: 'posibles clientes duplicados',
  'lead-de-cliente': 'posibles clientes que ya son clientes',
  'llc-sin-propietario': 'LLCs sin propietario cargado',
  estructura: 'estructura societaria que no coincide',
  'reuniones-sin-marcar': 'reuniones sin marcar si vino',
  'tratos-frenados': 'tratos abiertos frenados +90 días',
  'cadencias-vencidas': 'cadencias vencidas con el flag prendido',
  'canal-sin-leads': 'canales que dejaron de traer leads',
  'meta-sin-contactar': 'leads de Meta que nadie contactó',
  'mensajes-que-no-salieron': 'mensajes de cadencia que no salieron',
  'whatsapp-sin-numero': 'leads de WhatsApp sin número real',
  'renovacion-desfasada': 'renovaciones con la fecha en el año equivocado',
  'lead-sin-estado': 'leads que entraron sin estado',
  'cb-mal-clasificado': 'cuentas bancarias cargadas como apertura de LLC',
  'trato-sin-importe': 'tratos terminados sin importe',
  'trato-sin-contacto': 'tratos terminados sin contacto vinculado',
  'trato-sin-anuncio': 'tratos sin anuncio cuyo contacto sí lo tiene',
  'contacto-sin-llc': 'contactos sin la LLC vinculada',
  'trato-partner-sin-marcar': 'tratos de un socio sin marcar',
  'tratos-nuevos': 'tratos nuevos con datos faltantes',
  'fusion-sospechosa': 'fusiones que cambiaron de persona',
  'reuniones-en-llc-ajena': 'reuniones de otras personas colgadas de una LLC',
  'sin-retargeting-flujo': 'sin retargeting: el flujo no arrancó o se cortó',
  'sin-retargeting-estado': 'sin retargeting: en un estado sin cadencia',
  'puente-trato-sin-id': 'tratos nuevos sin Social Lead ID',
  'puente-meta-sin-tipo': 'leads de Meta que entraron sin Tipo',
  'puente-senal-sin-id': 'leads calificados que Meta no puede reconocer',
  'puente-sin-senal': 'el CRM no le manda señal de calidad a Meta',
};

// Las que de verdad significan "algo se trabo": un lead o un mensaje que no
// avanza. Las de datos sucios (estructura, propietario) van solo si aparecen
// nuevas, no como estancadas: llevan meses en el stock y serian ruido fijo.
const TRABAS = new Set([
  'meta-sin-contactar',
  'mensajes-que-no-salieron',
  'lead-sin-estado',
  'sin-retargeting-flujo',
  'canal-sin-leads',
  'whatsapp-sin-numero',
  'puente-sin-senal',
]);

const MAX_NUEVOS = 6;
const MAX_ESTANCADAS = 4;

const titulo = (clave) => TITULOS[clave] || clave;
const horaAr = (iso) =>
  new Date(iso).toLocaleString('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
    weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit',
  });

/**
 * El ultimo cierre que deberia existir: lun a vie 19:30 UTC (control-crm-cierre.mjs).
 * Se le da una hora de margen porque la corrida tarda un par de minutos.
 */
export function cierreEsperado(ahora) {
  const d = new Date(ahora);
  for (let i = 0; i < 8; i++) {
    const c = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - i, 19, 30));
    const dia = c.getUTCDay();
    if (dia === 0 || dia === 6) continue;
    if (c.getTime() + 60 * 60e3 <= ahora.getTime()) return c;
  }
  return null;
}

/**
 * @param {Array} bitacora  lo que devuelve store('control-crm').get('bitacora')
 * @param {{ahora: Date, yaInformado?: string}} op  yaInformado = id del cierre del informe anterior
 * @returns {{lineas: string[], cierreId: string|null, alerta: boolean}}
 */
export function bloqueCrm(bitacora, { ahora, yaInformado } = {}) {
  const lineas = [];
  const corridas = (bitacora || []).filter((r) => r.agente === 'control-crm');
  if (!corridas.length) {
    return { lineas: ['⚠️ Control CRM no dejó bitácora: no se puede saber qué está trabado.'], cierreId: null, alerta: true };
  }

  let alerta = false;
  const ultima = corridas[0];
  if (ultima.estado === 'error') {
    alerta = true;
    lineas.push(`⚠️ Control CRM falló en su última corrida (${horaAr(ultima.inicio || ultima.id)}): ${String(ultima.detalle || '').slice(0, 160)}`);
  }

  const cierres = corridas.filter((r) => r.modo === 'cierre' && r.estado === 'ok' && r.totales);
  const c = cierres[0];
  const esperado = cierreEsperado(ahora);
  if (!c || (esperado && new Date(c.fin || c.id) < esperado)) {
    alerta = true;
    lineas.push(`⚠️ Control CRM no cerró desde ${c ? horaAr(c.fin || c.id) : 'nunca'}: el aviso de las 16:30 no está corriendo.`);
  }
  if (!c) return { lineas, cierreId: null, alerta };

  if (c.id === yaInformado) {
    lineas.push(`Sin corrida nueva de Control CRM desde el informe anterior (último cierre: ${horaAr(c.fin || c.id)}).`);
    return { lineas, cierreId: c.id, alerta };
  }

  // 2. Lo nuevo desde el cierre anterior.
  const nuevos = Object.entries(c.totales)
    .filter(([, t]) => t.nuevos > 0)
    .sort((a, b) => b[1].nuevos - a[1].nuevos);
  for (const [clave, t] of nuevos.slice(0, MAX_NUEVOS)) {
    lineas.push(`${titulo(clave)}: +${t.nuevos} nuevos (${t.total} abiertos, ${t.resueltos} resueltos)`);
  }
  if (nuevos.length > MAX_NUEVOS) lineas.push(`y ${nuevos.length - MAX_NUEVOS} reglas más con casos nuevos.`);

  // 3. Lo estancado: 3 cierres seguidos sin resolver ninguno y sin bajar.
  const tres = cierres.slice(0, 3);
  if (tres.length === 3) {
    const estancadas = [...TRABAS]
      .filter((k) => tres.every((x) => x.totales?.[k]) && c.totales[k].total > 0)
      .filter((k) => tres.every((x) => x.totales[k].resueltos === 0))
      .filter((k) => c.totales[k].total >= tres[2].totales[k].total)
      .slice(0, MAX_ESTANCADAS);
    for (const k of estancadas) {
      lineas.push(`Estancado: ${titulo(k)} (${c.totales[k].total}), 3 cierres sin resolver ni uno.`);
    }
  }

  return { lineas, cierreId: c.id, alerta };
}
