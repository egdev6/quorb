//! Credenciales de 9Router: snapshot coherente + mutaciones serializadas con
//! generación. Toda escritura (login explícito, renovación, logout) pasa por aquí
//! y falla cerrado: nunca deja secretos utilizables bajo un destino ajeno.

use crate::secrets;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

/// Normaliza una Base URL de 9Router para comparar destinos (trim + sin `/` final).
pub fn normalize_base(url: &str) -> String {
    url.trim().trim_end_matches('/').to_string()
}

static LOCK: Mutex<()> = Mutex::new(());
static GENERATION: AtomicU64 = AtomicU64::new(0);

/// Vista coherente de los tres secretos en un solo instante (misma generación).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Snapshot {
    pub generation: u64,
    pub bound: Option<String>,
    pub password: Option<String>,
    pub session: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum PersistError {
    /// Otro hilo invalidó o cambió las credenciales mientras esperábamos red.
    Stale,
    Store(String),
}

/// Almacén de los tres secretos. Producción usa Credential Manager; tests un fake.
pub trait CredStore {
    fn get(&self, key: &str) -> Option<String>;
    fn set(&mut self, key: &str, value: &str) -> Result<(), String>;
}

struct KeyringStore;

impl CredStore for KeyringStore {
    fn get(&self, key: &str) -> Option<String> {
        secrets::get(key)
    }
    fn set(&mut self, key: &str, value: &str) -> Result<(), String> {
        secrets::set(key, value)
    }
}

fn non_empty(s: Option<String>) -> Option<String> {
    s.filter(|v| !v.trim().is_empty())
}

fn read_snapshot(store: &impl CredStore, generation: u64) -> Snapshot {
    Snapshot {
        generation,
        bound: store
            .get(secrets::NINE_ROUTER_BOUND_URL)
            .map(|s| normalize_base(&s))
            .filter(|s| !s.is_empty()),
        password: non_empty(store.get(secrets::NINE_ROUTER_PASSWORD)),
        session: non_empty(store.get(secrets::NINE_ROUTER_SESSION)),
    }
}

fn snapshot_matching(store: &impl CredStore, generation: u64, base: &str) -> Option<Snapshot> {
    let snap = read_snapshot(store, generation);
    let want = normalize_base(base);
    if snap.bound.as_deref() != Some(&want) {
        return None;
    }
    Some(snap)
}

/// Protocolo fail-closed compartido por producción y tests:
/// 1) invalidar el vínculo (sin él ningún snapshot autentica);
/// 2) escribir contraseña y cookie;
/// 3) publicar el vínculo (commit).
/// Si cualquier paso falla, se deja el vínculo vacío y se intenta limpiar
/// password/session. Secretos huérfanos sin bound no son utilizables.
fn write_bundle_fail_closed(
    store: &mut impl CredStore,
    base: &str,
    password: &str,
    cookie: &str,
) -> Result<(), String> {
    let normalized = normalize_base(base);
    // Invalidación primero: si no se puede, no se toca el resto (estado previo coherente).
    store.set(secrets::NINE_ROUTER_BOUND_URL, "")?;

    if let Err(e) = store.set(secrets::NINE_ROUTER_PASSWORD, password) {
        let _ = store.set(secrets::NINE_ROUTER_SESSION, "");
        let _ = store.set(secrets::NINE_ROUTER_PASSWORD, "");
        return Err(e);
    }
    if let Err(e) = store.set(secrets::NINE_ROUTER_SESSION, cookie) {
        let _ = store.set(secrets::NINE_ROUTER_PASSWORD, "");
        let _ = store.set(secrets::NINE_ROUTER_SESSION, "");
        // bound ya vacío → no utilizable aunque falle la limpieza
        return Err(e);
    }
    if let Err(e) = store.set(secrets::NINE_ROUTER_BOUND_URL, &normalized) {
        let _ = store.set(secrets::NINE_ROUTER_PASSWORD, "");
        let _ = store.set(secrets::NINE_ROUTER_SESSION, "");
        // bound queda vacío (o el set falló al escribir el nuevo; el clear ya pasó)
        let _ = store.set(secrets::NINE_ROUTER_BOUND_URL, "");
        return Err(e);
    }
    Ok(())
}

fn forget_bundle(store: &mut impl CredStore) -> Result<(), String> {
    let pass = store.set(secrets::NINE_ROUTER_PASSWORD, "");
    let sess = store.set(secrets::NINE_ROUTER_SESSION, "");
    let bound = store.set(secrets::NINE_ROUTER_BOUND_URL, "");
    match (pass, sess, bound) {
        (Ok(()), Ok(()), Ok(())) => Ok(()),
        (Err(e), _, _) | (_, Err(e), _) | (_, _, Err(e)) => Err(format!(
            "No se pudieron borrar las credenciales de 9Router: {e}"
        )),
    }
}

fn persist_if_gen(
    store: &mut impl CredStore,
    generation: &mut u64,
    base: &str,
    password: &str,
    cookie: &str,
    expected: u64,
) -> Result<(), PersistError> {
    if *generation != expected {
        return Err(PersistError::Stale);
    }
    write_bundle_fail_closed(store, base, password, cookie).map_err(PersistError::Store)?;
    *generation = generation.wrapping_add(1);
    Ok(())
}

/// ¿Clave gestionada solo por el coordinador de 9Router? (también con sufijo `@cuenta`).
pub fn is_managed_key(key: &str) -> bool {
    let base = key.split_once('@').map(|(b, _)| b).unwrap_or(key);
    matches!(
        base,
        secrets::NINE_ROUTER_PASSWORD
            | secrets::NINE_ROUTER_SESSION
            | secrets::NINE_ROUTER_BOUND_URL
    )
}

/// Snapshot solo si el vínculo coincide con `base`.
pub fn snapshot_for_base(base: &str) -> Option<Snapshot> {
    let _g = LOCK.lock().unwrap();
    snapshot_matching(&KeyringStore, GENERATION.load(Ordering::SeqCst), base)
}

/// Contraseña + generación vigentes para `base` (renovación automática).
pub fn password_ticket_for_base(base: &str) -> Option<(u64, String)> {
    snapshot_for_base(base).and_then(|s| s.password.map(|p| (s.generation, p)))
}

/// Generación actual bajo el lock: ticket para login explícito antes del `.await`.
pub fn begin_write_ticket() -> u64 {
    let _g = LOCK.lock().unwrap();
    GENERATION.load(Ordering::SeqCst)
}

/// Borra los tres secretos; sube generación primero (invalida respuestas pendientes).
pub fn forget_all() -> Result<(), String> {
    let _g = LOCK.lock().unwrap();
    GENERATION.fetch_add(1, Ordering::SeqCst);
    forget_bundle(&mut KeyringStore)
}

/// Persiste solo si la generación no cambió (login explícito / renovación tras red).
pub fn persist_if_generation(
    base: &str,
    password: &str,
    cookie: &str,
    generation: u64,
) -> Result<(), PersistError> {
    let _g = LOCK.lock().unwrap();
    let mut gen = GENERATION.load(Ordering::SeqCst);
    let result = persist_if_gen(
        &mut KeyringStore,
        &mut gen,
        base,
        password,
        cookie,
        generation,
    );
    if result.is_ok() {
        GENERATION.store(gen, Ordering::SeqCst);
    }
    result
}

// ── Fake inyectable (tests): misma write_bundle_fail_closed que producción ───

#[cfg(test)]
#[derive(Clone, Debug, Default)]
struct FakeStore {
    values: std::collections::BTreeMap<String, String>,
    /// Clave cuyo próximo `set` no vacío falla.
    fail_set: Option<String>,
    /// `set` a vacío de esta clave también falla (limpieza rota).
    fail_clear_key: Option<String>,
}

#[cfg(test)]
impl CredStore for FakeStore {
    fn get(&self, key: &str) -> Option<String> {
        self.values
            .get(key)
            .cloned()
            .filter(|s| !s.trim().is_empty())
    }
    fn set(&mut self, key: &str, value: &str) -> Result<(), String> {
        let empty = value.trim().is_empty();
        if empty {
            if self.fail_clear_key.as_deref() == Some(key) {
                return Err(format!("clear failed: {key}"));
            }
        } else if self.fail_set.as_deref() == Some(key) {
            return Err(format!("set failed: {key}"));
        }
        if empty {
            self.values.remove(key);
        } else {
            self.values
                .insert(key.to_string(), value.trim().to_string());
        }
        Ok(())
    }
}

#[cfg(test)]
impl FakeStore {
    fn seed(bound: &str, password: &str, session: &str) -> Self {
        let mut s = Self::default();
        s.values
            .insert(secrets::NINE_ROUTER_BOUND_URL.into(), normalize_base(bound));
        s.values
            .insert(secrets::NINE_ROUTER_PASSWORD.into(), password.into());
        s.values
            .insert(secrets::NINE_ROUTER_SESSION.into(), session.into());
        s
    }
}

/// Gestor de prueba: misma lógica que los wrappers globales, con almacén inyectado.
#[cfg(test)]
struct CredsCore<S> {
    store: S,
    generation: u64,
}

#[cfg(test)]
impl<S: CredStore> CredsCore<S> {
    fn snapshot_for_base(&self, base: &str) -> Option<Snapshot> {
        snapshot_matching(&self.store, self.generation, base)
    }

    fn begin_write_ticket(&self) -> u64 {
        self.generation
    }

    fn forget_all(&mut self) -> Result<(), String> {
        self.generation = self.generation.wrapping_add(1);
        forget_bundle(&mut self.store)
    }

    fn persist_if_generation(
        &mut self,
        base: &str,
        password: &str,
        cookie: &str,
        expected: u64,
    ) -> Result<(), PersistError> {
        persist_if_gen(
            &mut self.store,
            &mut self.generation,
            base,
            password,
            cookie,
            expected,
        )
    }

    fn write_bundle(&mut self, base: &str, password: &str, cookie: &str) -> Result<(), String> {
        write_bundle_fail_closed(&mut self.store, base, password, cookie)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn core_a() -> CredsCore<FakeStore> {
        CredsCore {
            store: FakeStore::seed("http://a", "pa", "cookie-a"),
            generation: 1,
        }
    }

    #[test]
    fn snapshot_a_then_connect_b_never_exposes_b_secrets_on_a() {
        let mut c = core_a();
        let snap_a = c.snapshot_for_base("http://a").unwrap();
        assert_eq!(snap_a.session.as_deref(), Some("cookie-a"));

        let ticket = c.begin_write_ticket();
        c.persist_if_generation("http://b", "pb", "cookie-b", ticket)
            .unwrap();

        assert!(c.snapshot_for_base("http://a").is_none());
        assert_eq!(
            c.snapshot_for_base("http://b").unwrap().session.as_deref(),
            Some("cookie-b")
        );
        assert_ne!(snap_a.session.as_deref(), Some("cookie-b"));
    }

    #[test]
    fn pending_auto_renewal_a_discarded_after_connect_b() {
        let mut c = core_a();
        let ticket = c.begin_write_ticket();
        c.persist_if_generation("http://b", "pb", "cookie-b", ticket)
            .unwrap();
        assert_eq!(
            c.persist_if_generation("http://a", "pa", "new-a", ticket),
            Err(PersistError::Stale)
        );
        assert_eq!(
            c.snapshot_for_base("http://b").unwrap().session.as_deref(),
            Some("cookie-b")
        );
    }

    #[test]
    fn pending_auto_renewal_discarded_after_logout() {
        let mut c = core_a();
        let ticket = c.begin_write_ticket();
        c.forget_all().unwrap();
        assert_eq!(
            c.persist_if_generation("http://a", "pa", "cookie-a", ticket),
            Err(PersistError::Stale)
        );
        assert!(c.snapshot_for_base("http://a").is_none());
    }

    #[test]
    fn explicit_login_a_pending_then_logout_discards_response() {
        let mut c = core_a();
        let ticket = c.begin_write_ticket();
        // await login A…
        c.forget_all().unwrap();
        assert_eq!(
            c.persist_if_generation("http://a", "pa", "fresh-a", ticket),
            Err(PersistError::Stale)
        );
    }

    #[test]
    fn explicit_login_a_pending_then_connect_b_keeps_b() {
        let mut c = CredsCore {
            store: FakeStore::default(),
            generation: 0,
        };
        let ticket_a = c.begin_write_ticket();
        // await A… meanwhile B connects
        let ticket_b = c.begin_write_ticket();
        c.persist_if_generation("http://b", "pb", "cookie-b", ticket_b)
            .unwrap();
        assert_eq!(
            c.persist_if_generation("http://a", "pa", "cookie-a", ticket_a),
            Err(PersistError::Stale)
        );
        assert_eq!(
            c.snapshot_for_base("http://b").unwrap().password.as_deref(),
            Some("pb")
        );
        assert!(c.snapshot_for_base("http://a").is_none());
    }

    #[test]
    fn older_pending_login_does_not_replace_newer_connection() {
        let mut c = CredsCore {
            store: FakeStore::default(),
            generation: 5,
        };
        let old = c.begin_write_ticket();
        let newer = c.begin_write_ticket();
        c.persist_if_generation("http://b", "pb", "cookie-b", newer)
            .unwrap();
        assert_eq!(
            c.persist_if_generation("http://a", "pa", "cookie-a", old),
            Err(PersistError::Stale)
        );
        assert_eq!(
            c.snapshot_for_base("http://b").unwrap().session.as_deref(),
            Some("cookie-b")
        );
    }

    #[test]
    fn bound_write_fail_and_session_clear_fail_leaves_secrets_unusable() {
        // B coherente → publicar A: clear bound OK, password/session OK, commit bound falla
        // y limpiar la cookie también falla. Bound vacío ⇒ ningún snapshot autentica.
        let mut c = CredsCore {
            store: FakeStore::seed("http://b", "pb", "cookie-b"),
            generation: 1,
        };
        c.store.fail_set = Some(secrets::NINE_ROUTER_BOUND_URL.into());
        c.store.fail_clear_key = Some(secrets::NINE_ROUTER_SESSION.into());
        assert!(c.write_bundle("http://a", "pa", "cookie-a").is_err());
        assert!(c.snapshot_for_base("http://a").is_none());
        assert!(c.snapshot_for_base("http://b").is_none());
        assert!(c.store.get(secrets::NINE_ROUTER_BOUND_URL).is_none());
    }

    #[test]
    fn session_write_fail_and_password_clear_fail_leaves_unusable() {
        let mut c = CredsCore {
            store: FakeStore::seed("http://b", "pb", "cookie-b"),
            generation: 1,
        };
        c.store.fail_set = Some(secrets::NINE_ROUTER_SESSION.into());
        c.store.fail_clear_key = Some(secrets::NINE_ROUTER_PASSWORD.into());
        assert!(c.write_bundle("http://a", "pa", "cookie-a").is_err());
        assert!(c.snapshot_for_base("http://a").is_none());
        assert!(c.snapshot_for_base("http://b").is_none());
        assert!(c.store.get(secrets::NINE_ROUTER_BOUND_URL).is_none());
    }

    #[test]
    fn managed_keys_detected_for_generic_setter() {
        assert!(is_managed_key(secrets::NINE_ROUTER_PASSWORD));
        assert!(is_managed_key(secrets::NINE_ROUTER_SESSION));
        assert!(is_managed_key(secrets::NINE_ROUTER_BOUND_URL));
        assert!(is_managed_key("nine_router_password@nine_router:x"));
        assert!(!is_managed_key(secrets::NAN_API_KEY));
        assert!(!is_managed_key("openrouter_api_key"));
    }
}
