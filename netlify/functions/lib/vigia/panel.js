// Errores del panel y pagos/firmas trabados. APAGADO hasta que Benja de la clave.
//
// Se prende solo cuando existen VIGIA_API_BASE y VIGIA_API_KEY en Netlify. La
// clave va en el header `x-vigia-key`. El contrato que se le pide a la API
// (a acordar con Benja, ver README):
//
//   GET {VIGIA_API_BASE}/errores?desde=ISO   -> errores del panel (lo de /panel/admin/logs?q=❌)
//   GET {VIGIA_API_BASE}/trabados?desde=ISO  -> pagos y firmas que no avanzan
//
// Cada uno devuelve una lista (pelada, o en `items` o `data`) de
// { mensaje|titulo, cantidad?, usuario|email?, cuando? }. Se tolera cualquiera
// de esas formas para no tener que tocar esto cuando la API exista.
const MAX = 6;

export const prendido = () => Boolean(process.env.VIGIA_API_BASE && process.env.VIGIA_API_KEY);

async function pedir(ruta, desde) {
  const base = process.env.VIGIA_API_BASE.replace(/\/$/, '');
  const r = await fetch(`${base}/${ruta}?desde=${encodeURIComponent(desde.toISOString())}`, {
    headers: { 'x-vigia-key': process.env.VIGIA_API_KEY, Accept: 'application/json' },
  });
  if (!r.ok) throw new Error(`${ruta}: HTTP ${r.status}`);
  const j = await r.json();
  return Array.isArray(j) ? j : j.items || j.data || [];
}

const linea = (x) => {
  const que = String(x.mensaje || x.titulo || x.message || 'sin detalle').replace(/\s+/g, ' ').slice(0, 140);
  const n = x.cantidad > 1 ? ` (x${x.cantidad})` : '';
  const quien = x.usuario || x.email ? `, ${x.usuario || x.email}` : '';
  return `${que}${n}${quien}`;
};

/** Devuelve { lineas, alerta }. Nunca tira: un bloque caido no tumba el informe. */
export async function bloquePanel(desde) {
  if (!prendido()) return { lineas: ['Errores del panel: pendiente de acceso'], alerta: false, apagado: true };
  const lineas = [];
  const crudos = [];
  let alerta = false;
  for (const [ruta, rotulo] of [['errores', 'Panel'], ['trabados', 'Trabado']]) {
    try {
      const items = await pedir(ruta, desde);
      if (items.length) alerta = true;
      // Lo crudo queda para el semanal (se guarda con la corrida del dia).
      for (const x of items.slice(0, 30)) crudos.push({ tipo: ruta, mensaje: linea(x), cantidad: Number(x.cantidad) || 1 });
      for (const x of items.slice(0, MAX)) lineas.push(`${rotulo}: ${linea(x)}`);
      if (items.length > MAX) lineas.push(`${rotulo}: y ${items.length - MAX} más.`);
    } catch (e) {
      lineas.push(`⚠️ ${rotulo}: no se pudo leer (${e.message})`);
    }
  }
  return { lineas, alerta, crudos };
}
