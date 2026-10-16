import settingsSource from '../Settings.tsx?raw';
import widgetSource from '../Widget.tsx?raw';
import libSource from '../../src-tauri/src/lib.rs?raw';
import { describe, expect, it } from 'vitest';

// Contrato de la desconexión de 9Router (regresión del punto 2 del feedback):
// «Quitar» debe borrar contraseña **y** cookie de sesión. Antes solo borraba la
// contraseña (`setSecret('nine_router_password', '')`) y la cookie seguía dando
// acceso hasta caducar. Ahora va por el comando `nineRouterLogout`, que limpia ambos.
describe('9Router disconnect', () => {
  it('borra ambos secretos con nineRouterLogout, no solo la contraseña', () => {
    expect(settingsSource).toContain('api.nineRouterLogout()');
    expect(settingsSource).not.toContain("api.setSecret('nine_router_password'");
  });

  // Regresión del punto 4: «Guardar y probar» debe usar la Base URL del borrador,
  // no la persistida (antes el backend leía la guardada y probaba contra la vieja).
  it('prueba el login contra la Base URL del borrador', () => {
    expect(settingsSource).toContain('api.nineRouterLogin(value, baseUrl)');
    expect(settingsSource).toContain('baseUrl={cfg.nineRouter.baseUrl}');
  });

  // 4º feedback P1: guardar una Base URL distinta debe invalidar los secretos del
  // destino anterior (si no, el siguiente fetch envía credenciales de A a B).
  // 5º feedback P1: invalidar ANTES de publicar B, propagar errores del almacén,
  // y vincular secretos al destino (bound_url) para consultas concurrentes.
  it('save_config invalida los secretos al cambiar la Base URL de 9Router', () => {
    expect(libSource).toContain('nine_router_destination_changed');
    expect(libSource).toContain('forget_nine_router_secrets');
    expect(libSource).toContain('invalidate_nine_router_before_destination_publish');
    expect(libSource).toContain('config_transaction::update(');
    expect(libSource).toContain('config_transaction::with_locked(&state.config, forget_nine_router_secrets)?');
    expect(libSource).toContain('nine_router_creds::forget_all');
    // Solo wiring: las carreras de la frontera compartida se ejecutan en los tests Rust.
    expect(libSource).toContain('config_transaction::snapshot_with_ticket(');
    expect(libSource).toContain('begin_write_ticket');
    expect(libSource).toContain('persist_if_generation');
  });

  // 4º feedback P2: conectar/desconectar no cambia la config, así que se necesita
  // una señal explícita de refresco (`refresh-now`) para el widget.
  it('login y logout piden refresco explícito del widget', () => {
    expect(libSource).toContain('refresh-now');
    expect(widgetSource).toContain("listen('refresh-now'");
  });

  // 6º feedback P2: set_secret no puede mutar claves de 9Router fuera del coordinador.
  it('rechaza las claves internas de 9Router en set_secret', () => {
    expect(libSource).toContain('is_managed_key');
    expect(libSource).toMatch(/set_secret[\s\S]*is_managed_key/);
  });
});
