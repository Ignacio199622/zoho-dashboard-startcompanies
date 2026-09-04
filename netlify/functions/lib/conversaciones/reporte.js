// Salida de Fase 0: lo que el agente habria avisado, para poder leerlo antes de
// enchufarlo a Slack de verdad.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { RAIZ } from './entorno.js';
import { CATEGORIAS } from './clasificar.js';
import { linkZoho, equipoDe } from './slack.js';
import { EQUIPOS } from './config.js';

const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function consola({ leidas, pendientes, alertas, descartadas, uso, costo, modoSombra }) {
  const L = console.log;
  L('');
  L('  AGENTE DE CONVERSACIONES · ' + new Date().toLocaleString('es-AR'));
  L('  ' + '─'.repeat(72));
  L(`  conversaciones con movimiento : ${leidas}`);
  L(`  esperando respuesta           : ${pendientes}`);
  L(`  alertas                       : ${alertas.length}`);
  L(`  descartadas por el filtro     : ${descartadas.length}`);
  if (uso) L(`  costo del modelo              : USD ${costo.toFixed(4)} (${uso.entrada}+${uso.salida} tokens)`);
  if (modoSombra) L('  MODO SOMBRA: no se aviso a nadie.');
  L('');

  for (const a of alertas) {
    const cat = CATEGORIAS[a.clase?.categoria] || CATEGORIAS.operativo;
    const nombre = a.ficha?.Full_Name || a.mobile_number__s;
    const rec = a.seguimiento?.accion === 'recordar' ? `🔁${a.seguimiento.numero} ` : '';
    L(`  ${rec}${cat.emoji} [p${a.decision.prioridad}] ${cat.etiqueta} · ${nombre}`);
    L(`     ${a.clase?.resumen || ''}`);
    L(`     "${String(a.last_message__s || '').replace(/\s+/g, ' ').slice(0, 110)}"`);
    if (a.clase?.accion) L(`     → ${a.clase.accion}`);
    if (a.clase?.borrador) L(`     ✎ ${a.clase.borrador}`);
    L(`     ${(a.decision.motivos || []).join(' · ')}`);
    L('');
  }

  if (descartadas.length) {
    L('  No alertadas:');
    for (const d of descartadas.slice(0, 25)) {
      const nombre = d.ficha?.Full_Name || d.mobile_number__s;
      L(`     · ${String(nombre).padEnd(28).slice(0, 28)} ${d.decision.motivo.padEnd(12)} "${String(d.last_message__s || '').replace(/\s+/g, ' ').slice(0, 60)}"`);
    }
    if (descartadas.length > 25) L(`     ... y ${descartadas.length - 25} mas`);
    L('');
  }
}

export function html({ leidas, pendientes, alertas, descartadas, costo, modoSombra }) {
  const fila = (a) => {
    const cat = CATEGORIAS[a.clase?.categoria] || CATEGORIAS.operativo;
    const nombre = esc(a.ficha?.Full_Name || a.mobile_number__s);
    const link = linkZoho(a.ficha);
    return `<tr>
      <td class="p">${cat.emoji} p${a.decision.prioridad}</td>
      <td><strong>${link ? `<a href="${link}">${nombre}</a>` : nombre}</strong>
          <div class="sub">${esc(EQUIPOS[equipoDe(a).clave].nombre)}: ${esc(
      EQUIPOS[equipoDe(a).clave].personas.join(', ')
    )} · ${a.horasEsperando}h esperando · ${
      a.ventanaCerrada ? '<span class="mal">ventana cerrada</span>' : `${a.horasDeVentana}h de ventana`
    }</div></td>
      <td>${esc(a.clase?.resumen)}<div class="msg">${esc(String(a.last_message__s || '').slice(0, 300))}</div></td>
      <td>${esc(a.clase?.accion || '')}
          ${a.clase?.borrador ? `<div class="borrador">${esc(a.clase.borrador)}</div>` : ''}
          <div class="sub">${esc((a.decision.motivos || []).join(' · '))}</div></td>
    </tr>`;
  };

  return `<!doctype html><meta charset="utf-8"><title>Agente de conversaciones</title>
<style>
  body{font:14px/1.5 -apple-system,Segoe UI,sans-serif;margin:0;padding:32px;background:#f6f8fb;color:#12203a}
  h1{font-size:20px;margin:0 0 4px}
  .fecha{color:#5b6b85;margin-bottom:20px}
  .kpis{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:24px}
  .kpi{background:#fff;border:1px solid #e2e8f2;border-radius:10px;padding:12px 18px;min-width:120px}
  .kpi b{display:block;font-size:24px}
  .kpi span{color:#5b6b85;font-size:12px}
  .aviso{background:#fff8e1;border:1px solid #f2d98a;border-radius:10px;padding:12px 16px;margin-bottom:20px}
  table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e2e8f2;border-radius:10px;overflow:hidden}
  th{background:#eef2f9;text-align:left;padding:10px 12px;font-size:12px;text-transform:uppercase;color:#5b6b85}
  td{padding:12px;border-top:1px solid #eef2f7;vertical-align:top}
  .p{white-space:nowrap;font-weight:600}
  .sub{color:#5b6b85;font-size:12px;margin-top:3px}
  .msg{color:#33445f;font-size:13px;margin-top:6px;padding-left:10px;border-left:3px solid #dbe3ef}
  .mal{color:#c0392b;font-weight:600}
  .borrador{background:#f2f7ff;border:1px solid #d6e4fb;border-radius:6px;padding:8px 10px;margin-top:8px;font-size:13px;color:#1c3d70}
  a{color:#0b57d0}
</style>
<h1>Agente de conversaciones · Start Companies</h1>
<div class="fecha">${new Date().toLocaleString('es-AR')}</div>
${modoSombra ? '<div class="aviso"><strong>Modo sombra.</strong> Estas alertas no se enviaron a nadie. Para activarlas hay que poner <code>SLACK_WEBHOOK_URL</code> en el <code>.env</code>.</div>' : ''}
<div class="kpis">
  <div class="kpi"><b>${leidas}</b><span>con movimiento</span></div>
  <div class="kpi"><b>${pendientes}</b><span>esperando respuesta</span></div>
  <div class="kpi"><b>${alertas.length}</b><span>alertas</span></div>
  <div class="kpi"><b>USD ${costo.toFixed(4)}</b><span>costo de la corrida</span></div>
</div>
<table>
  <tr><th>Prioridad</th><th>Quién</th><th>Qué dijo</th><th>Qué hacer</th></tr>
  ${alertas.map(fila).join('')}
</table>
${
  descartadas.length
    ? `<h1 style="margin-top:28px;font-size:16px">No alertadas (${descartadas.length})</h1>
<table><tr><th>Quién</th><th>Motivo</th><th>Mensaje</th></tr>
${descartadas
  .map(
    (d) =>
      `<tr><td>${esc(d.ficha?.Full_Name || d.mobile_number__s)}</td><td>${esc(d.decision.motivo)}</td><td class="msg">${esc(
        String(d.last_message__s || '').slice(0, 200)
      )}</td></tr>`
  )
  .join('')}
</table>`
    : ''
}`;
}

export function guardarHtml(contenido) {
  const dir = join(RAIZ, 'salidas');
  mkdirSync(dir, { recursive: true });
  const d = new Date();
  const sello = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  const ruta = join(dir, `sombra-${sello}.html`);
  writeFileSync(ruta, contenido, 'utf8');
  return ruta;
}
