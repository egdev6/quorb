import settingsSource from '../Settings.tsx?raw';
import { describe, expect, it } from 'vitest';

// Regresión del punto 3: 9Router no debe ofrecer el flujo genérico «+ Añadir
// cuenta», que crea un id aleatorio que nunca casa con los subproveedores
// descubiertos (su desglose se busca por el id real). Los subproveedores se
// descubren solos desde el historial de uso de 9Router.
describe('9Router account flow', () => {
  it('hides the generic add-account button for nine_router', () => {
    expect(settingsSource).toContain("tab === 'nine_router' ?");
    expect(settingsSource).toContain('se descubren solos desde su historial de uso');
  });
});
