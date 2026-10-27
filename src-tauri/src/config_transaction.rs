//! Frontera compartida de configuración y operaciones de credenciales.
//!
//! Las callbacks pueden adquirir el lock de credenciales, siempre después del de
//! configuración. Ninguna callback puede esperar red ni emitir eventos de UI.

use std::sync::Mutex;

/// Captura la configuración y el ticket que autoriza persistir tras la red.
pub(crate) fn snapshot_with_ticket<T: Clone, U>(
    config: &Mutex<T>,
    ticket: impl FnOnce() -> U,
) -> (T, U) {
    let guard = config.lock().unwrap();
    (guard.clone(), ticket())
}

/// Invalida y persiste antes de publicar; un fallo conserva la config publicada.
pub(crate) fn update<T: Clone, E>(
    config: &Mutex<T>,
    next: impl FnOnce(&T) -> T,
    before_publish: impl FnOnce(&T, &T) -> Result<(), E>,
    persist: impl FnOnce(&T) -> Result<(), E>,
) -> Result<(T, T), E> {
    let mut guard = config.lock().unwrap();
    let next = next(&guard);
    before_publish(&guard, &next)?;
    persist(&next)?;
    let old = std::mem::replace(&mut *guard, next.clone());
    Ok((old, next))
}

/// Coordina una invalidación (logout) con la captura de tickets y el guardado.
pub(crate) fn with_locked<T, U>(config: &Mutex<T>, action: impl FnOnce() -> U) -> U {
    let _guard = config.lock().unwrap();
    action()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicU64, Ordering},
        mpsc,
    };
    use std::thread;

    #[test]
    fn login_snapshot_cannot_take_a_new_ticket_for_an_old_destination() {
        let config = Mutex::new("A");
        let generation = AtomicU64::new(0);
        let (captured_tx, captured_rx) = mpsc::channel();
        let (resume_tx, resume_rx) = mpsc::channel();
        thread::scope(|scope| {
            let config = &config;
            let generation = &generation;
            let login = scope.spawn(move || {
                snapshot_with_ticket(config, || {
                    // Pausa exactamente después de clonar la config, antes del ticket.
                    captured_tx.send(()).unwrap();
                    resume_rx.recv().unwrap();
                    generation.load(Ordering::SeqCst)
                })
            });
            captured_rx.recv().unwrap();
            // Otro comando intenta guardar B en ese punto, sin esperar un reloj.
            let switched = match config.try_lock() {
                Ok(mut guard) => {
                    generation.fetch_add(1, Ordering::SeqCst);
                    *guard = "B";
                    true
                }
                Err(_) => false,
            };
            resume_tx.send(()).unwrap();
            let (base, ticket) = login.join().unwrap();
            assert!(!switched, "no se debe intercalar B entre config y ticket");
            assert_eq!((base, ticket), ("A", 0));
            with_locked(&config, || {
                generation.fetch_add(1, Ordering::SeqCst);
            });
            assert_ne!(
                ticket,
                generation.load(Ordering::SeqCst),
                "logout invalida el ticket capturado"
            );
        });
    }

    #[test]
    fn destination_invalidation_and_publication_are_one_boundary() {
        let config = Mutex::new("A");
        let generation = AtomicU64::new(0);
        let (invalidated_tx, invalidated_rx) = mpsc::channel();
        let (resume_tx, resume_rx) = mpsc::channel();
        thread::scope(|scope| {
            let config = &config;
            let generation = &generation;
            let save = scope.spawn(move || {
                update(
                    config,
                    |_| "B",
                    |_, _| {
                        generation.fetch_add(1, Ordering::SeqCst);
                        invalidated_tx.send(()).unwrap();
                        resume_rx.recv().unwrap();
                        Ok::<_, String>(())
                    },
                    |_| Ok(()),
                )
            });
            invalidated_rx.recv().unwrap();
            // Login no debe observar A con la generación ya invalidada para B.
            let intermediate = config
                .try_lock()
                .ok()
                .map(|guard| (*guard, generation.load(Ordering::SeqCst)));
            resume_tx.send(()).unwrap();
            save.join().unwrap().unwrap();
            assert_eq!(
                intermediate, None,
                "no publicar una frontera intermedia (A, generación de B)"
            );
            assert_eq!(
                snapshot_with_ticket(&config, || generation.load(Ordering::SeqCst)),
                ("B", 1)
            );
        });
    }

    #[test]
    fn failed_invalidation_does_not_persist_or_publish() {
        let config = Mutex::new("A");
        let result = update(
            &config,
            |_| "B",
            |_, _| Err("store locked"),
            |_| panic!("no persistir B"),
        );
        assert_eq!(result, Err("store locked"));
        assert_eq!(*config.lock().unwrap(), "A");
    }

    #[test]
    fn failed_persistence_does_not_publish_and_invalidates_old_ticket() {
        let config = Mutex::new("A");
        let generation = AtomicU64::new(0);
        let (_, old_ticket) = snapshot_with_ticket(&config, || generation.load(Ordering::SeqCst));
        let result = update(
            &config,
            |_| "B",
            |_, _| {
                generation.fetch_add(1, Ordering::SeqCst);
                Ok(())
            },
            |_| Err("disk full"),
        );
        assert_eq!(result, Err("disk full"));
        assert_eq!(*config.lock().unwrap(), "A");
        assert_ne!(old_ticket, generation.load(Ordering::SeqCst));
    }

    #[test]
    fn logout_runs_inside_the_same_config_boundary() {
        let config = Mutex::new("A");
        with_locked(&config, || assert!(config.try_lock().is_err()));
        assert!(config.try_lock().is_ok());
    }
}
