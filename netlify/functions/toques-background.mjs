// Una pasada del registro de toques (ver lib/toques.js). Solo lee Zoho.
import { pasadaToques } from './lib/toques.js';
import { avisarFalla } from './lib/aviso-falla.js';
export default async () => {
  try {
    const { resumen } = await pasadaToques();
    console.log('toques', JSON.stringify(resumen));
  } catch (e) {
    await avisarFalla('Toques de anuncios', e, 'lib/toques.js · solo lectura de Zoho, mirá si el token compartido está en pausa');
  }
};
