//! API keys guardadas en el almacén seguro del sistema
//! (Windows Credential Manager). Nunca se devuelven al frontend.

use std::collections::BTreeMap;

/// Nombre anterior de la app: se leen sus secretos una vez y se copian al nuevo.
const LEGACY_SERVICE: &str = "es.egdev.ai-usage";

pub const ANTHROPIC_ADMIN_KEY: &str = "anthropic_admin_key";
pub const OPENAI_ADMIN_KEY: &str = "openai_admin_key";
pub const NAN_API_KEY: &str = "nan_api_key";
/// Cookies de sesión de cloud.nan.builders (login por enlace de email, como la CLI oficial).
pub const NAN_SESSION: &str = "nan_session";

pub const OPENROUTER_API_KEY: &str = "openrouter_api_key";
/// Token fine-grained de GitHub con permiso «Plan» (lectura) para la facturación de Copilot.
pub const GITHUB_TOKEN: &str = "github_token";
/// Token de Cursor pegado a mano (si no, se lee de la app).
pub const CURSOR_TOKEN: &str = "cursor_token";
/// Contraseña del dashboard local de 9Router (para iniciar sesión y leer su uso).
pub const NINE_ROUTER_PASSWORD: &str = "nine_router_password";
/// Cookie de sesión del dashboard de 9Router (`auth_token`, dura 24 h).
pub const NINE_ROUTER_SESSION: &str = "nine_router_session";
/// Base URL a la que pertenecen contraseña/cookie. Sin este vínculo, o si no
/// coincide con el destino actual, no se envían (evita credenciales de A en B).
pub const NINE_ROUTER_BOUND_URL: &str = "nine_router_bound_url";

pub const ALL: [&str; 10] = [
    ANTHROPIC_ADMIN_KEY,
    OPENAI_ADMIN_KEY,
    NAN_API_KEY,
    NAN_SESSION,
    OPENROUTER_API_KEY,
    GITHUB_TOKEN,
    CURSOR_TOKEN,
    NINE_ROUTER_PASSWORD,
    NINE_ROUTER_SESSION,
    NINE_ROUTER_BOUND_URL,
];

/// Secretos que usa cada proveedor (las cuentas extra guardan los suyos con sufijo).
pub fn for_provider(provider: &str) -> &'static [&'static str] {
    match provider {
        "cursor" => &[CURSOR_TOKEN],
        "copilot" => &[GITHUB_TOKEN],
        "openrouter" => &[OPENROUTER_API_KEY],
        "anthropic_api" => &[ANTHROPIC_ADMIN_KEY],
        "openai_api" => &[OPENAI_ADMIN_KEY],
        "nan" => &[NAN_API_KEY, NAN_SESSION],
        // Contraseña + cookie + vínculo al destino (el bound_url no se edita en UI).
        "nine_router" => &[NINE_ROUTER_PASSWORD, NINE_ROUTER_SESSION, NINE_ROUTER_BOUND_URL],
        _ => &[],
    }
}

/// Nombre del secreto `key` para una cuenta extra (`openrouter_api_key@openrouter:a1b2c3`).
pub fn scoped(key: &str, account_id: &str) -> String {
    format!("{key}@{account_id}")
}

/// `key` o `key@<id de cuenta>`, con `key` de la lista y un id de cuenta válido.
fn is_known(key: &str) -> bool {
    match key.split_once('@') {
        None => ALL.contains(&key),
        Some((base, account)) => ALL.contains(&base) && crate::config::is_account_id(account),
    }
}

fn entry(key: &str) -> Result<keyring::Entry, String> {
    if !is_known(key) {
        return Err(format!("Clave desconocida: {key}"));
    }
    keyring::Entry::new(crate::channel::current().identifier, key).map_err(|e| e.to_string())
}

pub fn get(key: &str) -> Option<String> {
    let current = entry(key)
        .ok()?
        .get_password()
        .ok()
        .filter(|s| !s.trim().is_empty());
    if key.contains('@') || !crate::channel::current().migrate_legacy {
        return current;
    }
    current.or_else(|| migrate_legacy(key))
}

/// Si el secreto estaba guardado con el nombre anterior, lo copia al nuevo y lo devuelve.
fn migrate_legacy(key: &str) -> Option<String> {
    let old = keyring::Entry::new(LEGACY_SERVICE, key).ok()?;
    let value = old.get_password().ok().filter(|s| !s.trim().is_empty())?;
    if set(key, &value).is_ok() {
        let _ = old.delete_credential();
    }
    Some(value)
}

/// Guarda el secreto; si `value` está vacío lo borra.
pub fn set(key: &str, value: &str) -> Result<(), String> {
    let e = entry(key)?;
    let value = value.trim();
    if value.is_empty() {
        return match e.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(err.to_string()),
        };
    }
    e.set_password(value).map_err(|err| err.to_string())
}

/// Qué secretos hay configurados (sin revelar su valor), incluidos los de las cuentas extra.
pub fn status(accounts: &[crate::config::Account]) -> BTreeMap<String, bool> {
    let extra = accounts
        .iter()
        .flat_map(|a| for_provider(&a.provider).iter().map(move |k| scoped(k, &a.id)));
    ALL.iter().map(|k| k.to_string()).chain(extra).map(|k| {
        let set = get(&k).is_some();
        (k, set)
    }).collect()
}

/// Borra los secretos de una cuenta extra que se ha eliminado.
pub fn forget_account(account: &crate::config::Account) {
    for k in for_provider(&account.provider) {
        let _ = set(&scoped(k, &account.id), "");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scoped_keys_are_validated() {
        assert!(is_known(OPENROUTER_API_KEY));
        assert!(is_known(&scoped(OPENROUTER_API_KEY, "openrouter:a1b2c3")));
        assert!(!is_known("otra_cosa"));
        assert!(!is_known("otra_cosa@openrouter:a1b2c3"));
        assert!(!is_known("openrouter_api_key@../../x"));
    }

    #[test]
    fn nine_router_forgets_password_and_session_together() {
        // Regresión del punto 2: desconectar 9Router debe cubrir ambos secretos;
        // con solo la contraseña borrada, la cookie seguiría dando acceso 24 h.
        // P1 (5º feedback): también el vínculo al destino (bound_url).
        let keys = for_provider("nine_router");
        assert!(keys.contains(&NINE_ROUTER_PASSWORD));
        assert!(keys.contains(&NINE_ROUTER_SESSION));
        assert!(keys.contains(&NINE_ROUTER_BOUND_URL));
    }
}
