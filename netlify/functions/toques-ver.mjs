/*
 * La pantalla de los recorridos: quién compró y qué anuncios tocó antes.
 * Lee lo que dejó el agente (lib/toques.js) en Blobs; no toca Zoho ni escribe.
 *   /toques-ver                → los últimos compradores
 *   /toques-ver?tel=549381...  → el recorrido de una persona
 *   /toques-ver?json=1         → lo mismo en JSON
 */
import { getStore } from '@netlify/blobs';
import { recorridoDe } from './lib/toques.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const dia = (f) => String(f || '').slice(0, 10);
const ZOHO = 'https://crm.zoho.com/crm/org881745849/tab';

const fila = (p) => {
  const toques = p.toques.map((t) => `
    <li>
      <span class="f">${esc(dia(t.fecha))}</span>
      ${t.anuncio ? `<code>${esc(t.anuncio)}</code>` : '<span class="sin">sin anuncio</span>'}
      ${t.porDonde ? `<span class="tag">${esc(t.porDonde)}</span>` : ''}
      ${t.canal ? `<span class="canal">${esc(t.canal)}</span>` : ''}
      ${t.formulario ? '<span class="tag">form de Meta</span>' : ''}
    </li>`).join('');
  const compras = p.compras.map((c) => `
    <li class="compra">
      <span class="f">${esc(dia(c.fecha))}</span>
      <strong>${esc(c.nombre)}</strong>
      <span class="usd">${c.usd ? `${c.usd} USD` : ''}</span>
      ${c.socio ? `<span class="tag">socio ${esc(c.socio)}</span>` : ''}
    </li>`).join('');
  return `
  <article>
    <h3>${esc(p.nombre || '(sin nombre)')}
      <span class="chip">${p.resumen.toques} toque${p.resumen.toques === 1 ? '' : 's'}</span>
      <span class="chip ${p.resumen.anuncios > 1 ? 'ok' : ''}">${p.resumen.anuncios} anuncio${p.resumen.anuncios === 1 ? '' : 's'}</span>
      ${p.resumen.usd ? `<span class="chip usd">${p.resumen.usd} USD</span>` : ''}
    </h3>
    <ul>${toques}${compras}</ul>
  </article>`;
};

export default async (req) => {
  const url = new URL(req.url);
  const tel = url.searchParams.get('tel');
  const email = url.searchParams.get('email');
  const store = getStore({ name: 'toques', consistency: 'strong' });

  if (tel || email) {
    const p = await recorridoDe({ telefono: tel, email });
    if (url.searchParams.get('json')) return Response.json(p || { encontrado: false });
    return new Response(pagina(p ? [p] : [], { titulo: `Recorrido de ${esc(tel || email)}`, resumen: null }), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  const compradores = (await store.get('compradores', { type: 'json' }).catch(() => null)) || [];
  const resumen = (await store.get('resumen', { type: 'json' }).catch(() => null)) || null;
  if (url.searchParams.get('json')) return Response.json({ resumen, compradores });
  const orden = [...compradores].sort((a, b) => (b.resumen.anuncios - a.resumen.anuncios) || (b.resumen.toques - a.resumen.toques));
  return new Response(pagina(orden.slice(0, 120), { titulo: 'Recorridos de los que compraron', resumen }), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
};

const pagina = (lista, { titulo, resumen }) => `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(titulo)}</title>
<style>
 :root{--fondo:#0d1117;--caja:#161b22;--linea:#26303c;--texto:#e6edf3;--suave:#8b98a5;--ok:#3fb950;--usd:#e3b341;--azul:#58a6ff}
 *{box-sizing:border-box} body{margin:0;background:var(--fondo);color:var(--texto);font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;padding:24px 16px}
 .wrap{max-width:900px;margin:0 auto} h1{font-size:20px;margin:0 0 4px} .sub{color:var(--suave);font-size:13px;margin-bottom:20px}
 .cifras{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:22px}
 .cifra{background:var(--caja);border:1px solid var(--linea);border-radius:10px;padding:10px 14px;min-width:120px}
 .cifra b{display:block;font-size:22px} .cifra span{color:var(--suave);font-size:12px}
 article{background:var(--caja);border:1px solid var(--linea);border-radius:12px;padding:14px 16px;margin-bottom:12px}
 h3{font-size:15px;margin:0 0 10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
 ul{list-style:none;margin:0;padding:0;border-left:2px solid var(--linea);padding-left:14px}
 li{padding:4px 0;display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:13px}
 li.compra{border-top:1px dashed var(--linea);margin-top:6px;padding-top:8px}
 .f{color:var(--suave);font-variant-numeric:tabular-nums;min-width:82px}
 code{background:#21262d;border:1px solid var(--linea);border-radius:5px;padding:1px 6px;font-size:12px;color:var(--azul)}
 .sin{color:var(--suave);font-style:italic} .tag{background:#21262d;border-radius:5px;padding:1px 7px;font-size:12px;color:var(--suave)}
 .canal{font-size:12px;color:var(--suave)} .usd{color:var(--usd)}
 .chip{background:#21262d;border:1px solid var(--linea);border-radius:20px;padding:2px 9px;font-size:12px;color:var(--suave);font-weight:400}
 .chip.ok{color:var(--ok);border-color:var(--ok)} .chip.usd{color:var(--usd)}
 form{margin-bottom:20px;display:flex;gap:8px} input{background:var(--caja);border:1px solid var(--linea);color:var(--texto);border-radius:8px;padding:8px 10px;flex:1}
 button{background:var(--azul);border:0;border-radius:8px;padding:8px 16px;color:#0d1117;font-weight:600;cursor:pointer}
 .vacio{color:var(--suave);text-align:center;padding:40px 0}
</style></head><body><div class="wrap">
<h1>${esc(titulo)}</h1>
<p class="sub">Los clics que pasaron por lo nuestro, en orden. Las impresiones no existen: Meta no dice por persona qué anuncios mostró.${resumen ? ` · medido ${esc(dia(resumen.corrida))}` : ''}</p>
<form method="get"><input name="tel" placeholder="buscar por teléfono (+549…) o dejalo vacío para ver a todos"><button>Buscar</button></form>
${resumen ? `<div class="cifras">
  <div class="cifra"><b>${resumen.compradores}</b><span>compradores con recorrido</span></div>
  <div class="cifra"><b>${resumen.compradoresConVariosAnuncios}</b><span>con más de un anuncio</span></div>
  <div class="cifra"><b>${resumen.compradoresConUnAnuncio}</b><span>con un anuncio</span></div>
  <div class="cifra"><b>${resumen.compradoresSinAnuncio}</b><span>sin anuncio identificado</span></div>
</div>` : ''}
${lista.length ? lista.map(fila).join('') : '<p class="vacio">No hay recorrido guardado para eso.</p>'}
</div></body></html>`;
