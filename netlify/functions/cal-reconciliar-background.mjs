// Una pasada del reconciliador Cal → Zoho (ver lib/cal-reconciliar.js).
import { pasadaReconciliar } from './lib/cal-reconciliar.js';
export default async () => {
  try {
    const r = await pasadaReconciliar();
    console.log('cal-reconciliar', JSON.stringify(r));
  } catch (e) {
    console.error('cal-reconciliar falló', e);
  }
};
