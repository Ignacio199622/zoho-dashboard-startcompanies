// Salida del modo sombra: lo que el agente HABRIA mandado, y por que no mando
// el resto. Dos formatos: consola (para correrlo a mano) y HTML (para leerlo
// tranquilo o mandarlo por mail).
import { formatearEn } from './tz.js';
import { TZ_OPERACION } from './config.js';

const ETIQUETA = {
  recordatorio: 'Recordatorio (dia previo)',
  confirmacion: 'Confirmacion (mismo dia)',
  rescate: 'Rescate (no aparecio)',
};

const TITULO_ALERTA = {
  status_incoherente: 'Reunion futura ya marcada',
  sin_vinculo: 'Reunion sin persona vinculada',
  colision_retargeting: 'Choque con la cadencia de Zoho',
  reuniones_duplicadas: 'Persona con reuniones repetidas',
  rescate_omitido: 'Falto pero tiene otra reunion en pie',
};

export function consola({ acciones, descartes, alertas }, ahora, totalReuniones) {
  const L = [];
  L.push('');
  L.push('='.repeat(78));
  L.push(`  AGENTE ANTI NO-SHOW  ·  MODO SOMBRA  ·  ${formatearEn(ahora, TZ_OPERACION)}`);
  L.push(`  No se envio ningun mensaje. Esto es lo que habria hecho.`);
  L.push('='.repeat(78));
  L.push('');
  L.push(
    `Reuniones en la ventana: ${totalReuniones}   ` +
      `Mensajes que habria mandado: ${acciones.length}   ` +
      `Alertas: ${alertas.length}`
  );

  if (acciones.length) {
    L.push('');
    L.push('-'.repeat(78));
    L.push('  MENSAJES QUE HABRIA MANDADO');
    L.push('-'.repeat(78));
    for (const a of acciones) {
      L.push('');
      L.push(`  ${ETIQUETA[a.tipo]}  ->  ${a.nombre}   ${a.telefono}`);
      const horaCliente = formatearEn(a.inicio, a.tz);
      L.push(
        `  Reunion: ${formatearEn(a.inicio, TZ_OPERACION)} (hora AR)` +
          (horaCliente ? `  ·  ${horaCliente} (hora del cliente${a.tzAprox ? ', aprox' : ''})` : '') +
          `  ·  faltan ${a.faltanH.toFixed(1)}h`
      );
      L.push('');
      for (const linea of a.texto.split('\n')) L.push(`      | ${linea}`);
    }
  }

  if (alertas.length) {
    L.push('');
    L.push('-'.repeat(78));
    L.push('  ALERTAS (cosas para mirar, no mensajes)');
    L.push('-'.repeat(78));
    const porTipo = new Map();
    for (const al of alertas) {
      if (!porTipo.has(al.tipo)) porTipo.set(al.tipo, []);
      porTipo.get(al.tipo).push(al);
    }
    for (const [tipo, lista] of porTipo) {
      L.push('');
      L.push(`  ${TITULO_ALERTA[tipo] || tipo}  (${lista.length})`);
      for (const al of lista) {
        L.push(`    · ${al.nombre || '(sin nombre)'} · ${formatearEn(al.inicio, TZ_OPERACION)}`);
        L.push(`      ${al.detalle}`);
      }
    }
  }

  if (descartes.length) {
    L.push('');
    L.push('-'.repeat(78));
    L.push('  NO SE ESCRIBIO A ESTOS, Y POR QUE');
    L.push('-'.repeat(78));
    const porMotivo = new Map();
    for (const d of descartes) {
      const k = d.motivo.replace(/"[^"]*"/g, '"..."');
      if (!porMotivo.has(k)) porMotivo.set(k, []);
      porMotivo.get(k).push(d);
    }
    for (const [motivo, lista] of [...porMotivo].sort((a, b) => b[1].length - a[1].length)) {
      L.push(`  ${String(lista.length).padStart(3)}  ${motivo}`);
      if (lista.length <= 6) {
        for (const d of lista) {
          L.push(`         ${d.nombre || '(sin nombre)'} · ${formatearEn(d.inicio, TZ_OPERACION)}`);
        }
      }
    }
  }

  L.push('');
  return L.join('\n');
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function html({ acciones, descartes, alertas }, ahora, totalReuniones) {
  const tarjetas = acciones
    .map(
      (a) => `
    <article class="msg">
      <header>
        <span class="tag t-${a.tipo}">${esc(ETIQUETA[a.tipo])}</span>
        <strong>${esc(a.nombre)}</strong>
        <span class="tel">${esc(a.telefono)}</span>
      </header>
      <p class="meta">
        Reunion ${esc(formatearEn(a.inicio, TZ_OPERACION))} hora AR
        ${a.tz ? `· ${esc(formatearEn(a.inicio, a.tz))} hora del cliente${a.tzAprox ? ' (aprox)' : ''}` : ''}
        · faltan ${a.faltanH.toFixed(1)}h
      </p>
      <pre class="burbuja">${esc(a.texto)}</pre>
    </article>`
    )
    .join('');

  const porTipoAlerta = new Map();
  for (const al of alertas) {
    if (!porTipoAlerta.has(al.tipo)) porTipoAlerta.set(al.tipo, []);
    porTipoAlerta.get(al.tipo).push(al);
  }
  const bloquesAlerta = [...porTipoAlerta]
    .map(
      ([tipo, lista]) => `
    <div class="alerta">
      <h3>${esc(TITULO_ALERTA[tipo] || tipo)} <span class="n">${lista.length}</span></h3>
      <ul>${lista
        .map(
          (al) =>
            `<li><strong>${esc(al.nombre || '(sin nombre)')}</strong> · ${esc(
              formatearEn(al.inicio, TZ_OPERACION)
            )}<br><span>${esc(al.detalle)}</span></li>`
        )
        .join('')}</ul>
    </div>`
    )
    .join('');

  const porMotivo = new Map();
  for (const d of descartes) {
    const k = d.motivo.replace(/"[^"]*"/g, '"..."');
    porMotivo.set(k, (porMotivo.get(k) || 0) + 1);
  }
  const filasDescarte = [...porMotivo]
    .sort((a, b) => b[1] - a[1])
    .map(([m, n]) => `<tr><td class="num">${n}</td><td>${esc(m)}</td></tr>`)
    .join('');

  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agente anti no-show · modo sombra</title>
<style>
  :root{--bg:#0d1117;--card:#161b22;--bd:#2a3441;--tx:#e6edf3;--dim:#8b949e;--az:#1e6fff;--cy:#22d3ee;--am:#f59e0b}
  *{box-sizing:border-box}
  body{margin:0;padding:24px;background:var(--bg);color:var(--tx);
       font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
  .wrap{max-width:860px;margin:0 auto}
  h1{font-size:21px;margin:0 0 4px}
  .sub{color:var(--dim);font-size:14px;margin:0 0 20px}
  .kpis{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:26px}
  .kpi{background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:12px 16px;flex:1;min-width:150px}
  .kpi b{display:block;font-size:26px;line-height:1.1}
  .kpi span{color:var(--dim);font-size:13px}
  h2{font-size:15px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);
     border-bottom:1px solid var(--bd);padding-bottom:7px;margin:32px 0 14px}
  .msg{background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:14px 16px;margin-bottom:14px}
  .msg header{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:6px}
  .tag{font-size:11px;padding:3px 8px;border-radius:99px;font-weight:600}
  .t-recordatorio{background:#12315e;color:#8ab4ff}
  .t-confirmacion{background:#0d3c46;color:#67e8f9}
  .t-rescate{background:#4a2c05;color:#fbbf24}
  .tel{color:var(--dim);font-size:13px;font-family:ui-monospace,monospace}
  .meta{color:var(--dim);font-size:12.5px;margin:0 0 10px}
  .burbuja{background:#0b3d2e;border-left:3px solid #22c55e;border-radius:0 8px 8px 0;
     padding:11px 13px;margin:0;white-space:pre-wrap;font:14px/1.5 inherit;color:#d7f5e6}
  .alerta{background:var(--card);border:1px solid var(--bd);border-left:3px solid var(--am);
     border-radius:0 10px 10px 0;padding:12px 16px;margin-bottom:12px}
  .alerta h3{font-size:14px;margin:0 0 8px}
  .alerta .n{background:var(--am);color:#000;border-radius:99px;padding:1px 7px;font-size:12px;margin-left:6px}
  .alerta ul{margin:0;padding-left:18px}
  .alerta li{margin-bottom:7px;font-size:13.5px}
  .alerta li span{color:var(--dim);font-size:13px}
  table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--bd);border-radius:10px;overflow:hidden}
  td{padding:8px 14px;border-bottom:1px solid var(--bd);font-size:14px}
  tr:last-child td{border-bottom:none}
  .num{width:56px;text-align:right;font-weight:700;color:var(--cy);font-family:ui-monospace,monospace}
  footer{margin-top:34px;color:var(--dim);font-size:12.5px;border-top:1px solid var(--bd);padding-top:14px}
</style></head><body><div class="wrap">
  <h1>Agente anti no-show · modo sombra</h1>
  <p class="sub">${esc(formatearEn(ahora, TZ_OPERACION))} · No se envio ningun mensaje. Esto es lo que habria hecho.</p>
  <div class="kpis">
    <div class="kpi"><b>${totalReuniones}</b><span>reuniones en la ventana</span></div>
    <div class="kpi"><b>${acciones.length}</b><span>mensajes que habria mandado</span></div>
    <div class="kpi"><b>${alertas.length}</b><span>alertas para revisar</span></div>
  </div>
  ${acciones.length ? `<h2>Mensajes que habria mandado</h2>${tarjetas}` : '<h2>Mensajes</h2><p class="sub">Ninguna reunion cae en una ventana de envio en este momento.</p>'}
  ${alertas.length ? `<h2>Alertas</h2>${bloquesAlerta}` : ''}
  ${descartes.length ? `<h2>No se escribio a estos, y por que</h2><table>${filasDescarte}</table>` : ''}
  <footer>Fase 0. El agente solo lee Zoho: no escribe en el CRM ni manda WhatsApp.</footer>
</div></body></html>`;
}
