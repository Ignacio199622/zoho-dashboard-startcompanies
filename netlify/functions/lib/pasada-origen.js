// La pasada de atribucion, en un solo lugar.
//
// La corren dos: `atar-y-traspasar.js` a mano (la pasada historica) y la funcion
// `origen-tratos.mjs` cada hora (para que los tratos nuevos no vuelvan a nacer
// sin origen). Viven aca juntas a proposito: si cada una tuviera su copia, una
// se arregla y la otra sigue corriendo mal en produccion sin que nada avise.
//
// Dos etapas, en este orden, porque la segunda depende de la primera:
//   1. ATAR   el trato huerfano a su cliente (via la cuenta, si es inequivoco)
//   2. COPIAR el origen del cliente al trato
// Un trato atado en la etapa 1 entra a la 2 en la misma corrida.
//
// NO ADIVINA. Solo escribe cuando la respuesta es una sola, y nunca pisa un
// campo que ya tiene valor.
import {
  CAMPOS_CONTACTO, CAMPOS_TRATO, CAMPOS_CUENTA_CONTACTO,
  loQueFaltaAlTrato, contactosPorCuenta, clienteDelTratoHuerfano,
  clientePorHermanos, tratosPorCuenta, canalDeLaCuenta, canalDeSocio,
} from './traspaso.js';
import { dormir } from './reintentar.js';

const API = 'https://www.zohoapis.com/crm/v6';

/**
 * Trae un modulo entero.
 *
 * Con page_token, no con `page`: Zoho corta en 2000 registros cuando se pagina
 * por numero de pagina, y lo hace devolviendo un error en la pagina 11 que es
 * facil de leer como "se acabaron los registros". Con 3.511 eventos y 1.099
 * tratos eso significaba medir sobre una muestra creyendo que era el total.
 */
export async function traer(H, modulo, campos, maxPaginas = 60) {
  const out = [];
  let token = null;
  for (let p = 0; p < maxPaginas; p++) {
    const u = `${API}/${modulo}?fields=${campos}&per_page=200&sort_by=Created_Time&sort_order=desc`
      + (token ? `&page_token=${encodeURIComponent(token)}` : '');
    const r = await fetch(u, { headers: H });
    if (r.status === 204) break;
    const j = await r.json();
    if (!j.data) break;
    out.push(...j.data);
    token = j.info?.next_page_token || null;
    if (!token) break;
  }
  return out;
}

/**
 * Los mensajes que salieron a partir de `desde`. Es el freno de mano: editar un
 * registro de Zoho puede disparar automatizaciones, y en agosto una regla en
 * bucle mando la misma plantilla cada 3 minutos hasta que Meta bloqueo el
 * numero. Se mira despues de CADA escritura, no al final.
 */
export async function huboEnvios(H, modulo, id, desde) {
  const r = await fetch(`${API}/${modulo}/${id}/__timeline?per_page=25`, { headers: H });
  if (!r.ok) return [];
  return ((await r.json()).__timeline || []).filter(
    (x) => new Date(x.audited_time).getTime() >= desde && /messagenotificationsent|email_notification|notification/i.test(x.action || '')
  );
}

/** Lo que hay para hacer, sin escribir nada. */
export async function planificar(H, { desde = null, maxPaginasTratos = 12 } = {}) {
  const [tratosTodos, contactos, cuentasArr] = await Promise.all([
    traer(H, 'Deals', CAMPOS_TRATO, maxPaginasTratos),
    traer(H, 'Contacts', [CAMPOS_CONTACTO, 'Account_Name'].join(','), 12),
    traer(H, 'Accounts', 'id,Account_Name,Fuente,Landing_Origen', 12),
  ]);
  const cuentas = new Map(cuentasArr.map((a) => [a.id, a]));
  const tratos = desde ? tratosTodos.filter((d) => (d.Created_Time || '') >= desde) : tratosTodos;

  const porId = new Map(contactos.map((c) => [c.id, c]));
  const porCuenta = contactosPorCuenta(contactos);
  // Para la segunda via hay que mirar TODOS los tratos, no solo los de la
  // ventana: el hermano que tiene cliente puede ser de hace un año.
  const porCuentaTratos = tratosPorCuenta(tratosTodos);

  const atar = [];
  const copiar = [];
  const motivos = {};

  for (const d of tratos) {
    let cliente = d.Contact_Name?.id ? porId.get(d.Contact_Name.id) : null;

    if (!cliente) {
      // 1a via: la cuenta tiene un solo contacto. 2a via: un trato hermano.
      let r = clienteDelTratoHuerfano(d, porCuenta);
      if (!r.contacto) {
        const h = clientePorHermanos(d, porCuentaTratos);
        if (h.contacto) r = { contacto: porId.get(h.contacto.id) || h.contacto, via: 'hermano' };
        else r = { motivo: `${r.motivo} / ${h.motivo}` };
      }
      if (r.contacto) {
        atar.push({ trato: d, contacto: r.contacto, via: r.via || 'cuenta' });
        cliente = r.contacto; // sigue a la etapa 2 en la misma corrida
      } else {
        motivos[r.motivo] = (motivos[r.motivo] || 0) + 1;
        // Sin cliente no se le puede copiar nada, pero la LLC todavia puede
        // darle el canal, que es el dato que mas se usa.
        const socio = canalDeSocio(d, null);
        const deLaLlc = socio || canalDeLaCuenta(d, cuentas);
        if (deLaLlc) copiar.push({ trato: d, cliente: null, cambios: { Lead_Source: deLaLlc }, detalle: [socio ? 'Lead_Source (socio)' : 'Lead_Source (de la LLC)'] });
        continue;
      }
    }

    const f = loQueFaltaAlTrato(d, cliente);
    // La venta por socio pisa un canal débil (Sin dato histórico / WhatsApp (no sabemos)) del contacto.
    const socio = canalDeSocio(d, cliente);
    if (socio && (!f.cambios.Lead_Source || f.cambios.Lead_Source === 'Sin dato histórico' || f.cambios.Lead_Source === 'WhatsApp (no sabemos)' || f.cambios.Lead_Source === 'Sin origen de fuente')) { f.cambios.Lead_Source = socio; f.detalle.push('Lead_Source (socio)'); }
    // Si ni el cliente ni el trato saben el canal, queda la LLC. Es lo que hace
    // que una renovacion herede el origen de la apertura de hace un año.
    if (!f.cambios.Lead_Source) {
      const deLaLlc = canalDeLaCuenta(d, cuentas);
      if (deLaLlc) { f.cambios.Lead_Source = deLaLlc; f.detalle.push('Lead_Source (de la LLC)'); }
    }
    if (Object.keys(f.cambios).length) copiar.push({ trato: d, cliente, ...f });
  }

  return { tratos, contactos, atar, copiar, motivos };
}

/**
 * Escribe. Corta la corrida entera si una escritura dispara un mensaje.
 * @param {(ev:object)=>Promise<void>} alCortar que hacer cuando hay que frenar
 * @returns {{atados:number, copiados:number, cortado:object|null, errores:object[]}}
 */
export async function aplicar(H, { atar = [], copiar = [] }, { maxAtar = 9999, maxCopiar = 9999, alCortar = null, alAvanzar = null } = {}) {
  const errores = [];
  let atados = 0;
  let copiados = 0;

  const escribir = async (cuerpo, etiqueta) => {
    const t0 = Date.now();
    const r = await fetch(`${API}/Deals`, {
      method: 'PUT',
      headers: { ...H, 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: [cuerpo] }),
    });
    const d = ((await r.json()).data || [])[0];
    if (d?.code !== 'SUCCESS') throw new Error(`${d?.code} ${d?.message}`);

    const envios = await huboEnvios(H, 'Deals', cuerpo.id, t0 - 5000);
    if (envios.length) {
      const ev = { trato: cuerpo.id, etiqueta, envios: envios.length };
      if (alCortar) await alCortar(ev);
      return { cortado: ev };
    }
    await dormir(350);
    return {};
  };

  for (const p of atar.slice(0, maxAtar)) {
    try {
      const r = await escribir({ id: p.trato.id, Contact_Name: { id: p.contacto.id } }, 'atar');
      if (r.cortado) return { atados, copiados, cortado: r.cortado, errores };
      atados++;
      if (alAvanzar) alAvanzar('atar', atados, p);
    } catch (e) {
      errores.push({ paso: 'atar', trato: p.trato.id, mensaje: String(e.message).slice(0, 160) });
    }
  }

  for (const p of copiar.slice(0, maxCopiar)) {
    try {
      const r = await escribir({ id: p.trato.id, ...p.cambios }, 'copiar');
      if (r.cortado) return { atados, copiados, cortado: r.cortado, errores };
      copiados++;
      if (alAvanzar) alAvanzar('copiar', copiados, p);
    } catch (e) {
      errores.push({ paso: 'copiar', trato: p.trato.id, mensaje: String(e.message).slice(0, 160) });
    }
  }

  return { atados, copiados, cortado: null, errores };
}
