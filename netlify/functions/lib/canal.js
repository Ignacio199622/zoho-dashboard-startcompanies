// De qué canal vino un lead, resuelto con lo que YA está en su ficha de Zoho.
//
// POR QUE EXISTE (medido el 2026-09-04 sobre 2.000 leads desde febrero):
// El campo `Landing_Origen` venia lleno al 90-95% durante todo julio y se cayo
// al 4% en agosto. No fue que dejo de llegar el dato: `Calendario`, que trae el
// slug de la landing, sigue en 28%, igual que en julio. Lo que dejo de correr
// es lo que TRADUCIA ese slug a un canal.
//
// Semana a semana: 29-jun 95% · 06-jul 94% · 20-jul 91% · 27-jul 60% ·
// 03-ago 20% · 10-ago 6% · 17-ago 0%.
//
// OJO CON LOS NOMBRES DE LOS CAMPOS, que confunden:
//   `Calendario`      = el slug de la landing ("asesoria-llc"). El dato crudo.
//   `Landing_Origen`  = el CANAL ("Meta Ads"). No guarda una landing, pese al
//                       nombre: su picklist son canales.
import { LANDING_A_CANAL } from './mapeos.js';

// Paginas del sitio, no landings de campaña. Quien llega ahi sin fbclid ni utm
// vino por su cuenta.
const PAGINAS_DEL_SITIO = new Set(['/', 'precios']);

// Estas NO se resuelven por el slug, a proposito: son paginas de agendamiento
// genericas a las que se llega desde un mail, un WhatsApp, la bio o un anuncio.
// Si tienen fbclid se resuelven por ahi; si no, quedan vacias. Un canal
// inventado es peor que uno vacio, porque nadie lo vuelve a revisar.
const AGENDAMIENTO_GENERICO = new Set(['agendar', 'agendamientoform']);

const limpiar = (s) => String(s || '').toLowerCase().trim().replace(/^\//, '') || (String(s || '').trim() === '/' ? '/' : '');

/**
 * Las señales van de mas dura a mas blanda. `utm_source` lo puso la campaña,
 * `fbclid` lo agrega Meta al hacer clic en un anuncio, y el slug es lo mas
 * debil porque a la misma pagina se llega de cualquier lado.
 *
 * @param {object} lead ficha de Zoho
 * @returns {{canal: string|null, via: string}}
 */
export function canalDelLead(lead) {
  if (!lead) return { canal: null, via: 'sin ficha' };

  const src = String(lead.utm_source || '').toLowerCase();
  if (src) {
    if (/ig|fb|facebook|instagram|meta|an$/.test(src)) return { canal: 'Meta Ads', via: `utm_source=${lead.utm_source}` };
    if (/google|gads|adwords/.test(src)) return { canal: 'Google Ads', via: `utm_source=${lead.utm_source}` };
    if (/reddit/.test(src)) return { canal: 'Reddit', via: `utm_source=${lead.utm_source}` };
    if (/youtube|yt/.test(src)) return { canal: 'YouTube Ads', via: `utm_source=${lead.utm_source}` };
  }

  // fbclid o creativeId son prueba de que hubo un clic en un anuncio de Meta,
  // aunque despues haya aterrizado en cualquier pagina.
  if (lead.fbclid) return { canal: 'Meta Ads', via: 'fbclid' };
  if (lead.creativeId) return { canal: 'Meta Ads', via: 'creativeId' };

  // EL SOCIAL LEAD ID VA ANTES QUE EL CALENDARIO, Y ESTO NO ES UN DETALLE.
  // Quien llena un formulario DENTRO de Meta nunca abre un navegador, asi que
  // no trae fbclid ni utm. Despues agenda por `agenda-organica` y el slug lo
  // hace parecer trafico organico. Es de Meta.
  // El calendario dice COMO agendo, no DE DONDE VINO: por eso pierde contra
  // cualquier marca de origen. (Roto y corregido el 4-sep: 6 leads de Meta
  // habian quedado como "SEO / Web Orgánica" por este orden.)
  if (lead.leadchain0__Social_Lead_ID) return { canal: 'Meta Ads', via: 'Social Lead ID (formulario de Meta)' };

  const slug = limpiar(lead.Calendario);
  if (!slug) return { canal: null, via: 'la ficha no tiene Calendario' };
  if (AGENDAMIENTO_GENERICO.has(slug)) {
    return { canal: null, via: `"${slug}" es una pagina de agendamiento generica: no dice el canal` };
  }
  if (PAGINAS_DEL_SITIO.has(slug)) return { canal: 'SEO / Web Orgánica', via: `pagina del sitio ${slug === '/' ? '/' : '/' + slug}` };

  const canal = LANDING_A_CANAL[slug];
  return canal
    ? { canal, via: `landing ${slug}` }
    : { canal: null, via: `landing "${slug}" sin canal asignado en el mapeo` };
}

/** Los campos que hay que pedirle a Zoho para poder decidir. */
export const CAMPOS = 'id,Full_Name,Created_Time,Lead_Source,Calendario,Landing_Origen,fbclid,creativeId,utm_source,utm_campaign,leadchain0__Social_Lead_ID';
