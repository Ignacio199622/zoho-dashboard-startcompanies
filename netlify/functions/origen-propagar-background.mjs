// Una pasada del traspaso de origen lead → contacto → trato (ver lib/origen-propagar.js).
// Solo avisa en Slack cuando escribió algo: un agente que postea "0 cambios"
// cada hora deja de leerse a la semana.
import { pasadaOrigen } from './lib/origen-propagar.js';
import { avisarFalla, avisarResumen } from './lib/aviso-falla.js';

export default async () => {
  try {
    const r = await pasadaOrigen({ aplicar: process.env.ORIGEN_PROPAGAR_APLICAR !== '0' });
    console.log('origen-propagar', JSON.stringify({ ...r, detalle: undefined, plan: undefined }));
    if (r.campos || r.etiquetas || r.fallos.length) {
      await avisarResumen('Origen al día', `${r.campos} campos y ${r.etiquetas} etiquetas en ${r.contactos} contactos y ${r.tratos} tratos${r.fallos.length ? ` · ${r.fallos.length} fallos` : ''}`, [...r.detalle, ...r.fallos]);
    }
  } catch (e) {
    await avisarFalla('Origen al día', e, 'lib/origen-propagar.js · mirá si Zoho devolvió 401 (token compartido) antes que el código');
  }
};
