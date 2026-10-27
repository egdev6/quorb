fn main() {
    println!("cargo:rerun-if-env-changed=TAURI_CONFIG");
    println!("cargo:rerun-if-changed=tauri.conf.json");
    println!("cargo:rerun-if-changed=icons");
    let base: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string("tauri.conf.json").expect("Tauri config"))
            .expect("Valid Tauri config");
    let overlay: serde_json::Value = std::env::var("TAURI_CONFIG")
        .map(|json| serde_json::from_str(&json).expect("Valid Tauri overlay"))
        .unwrap_or(serde_json::Value::Null);
    let identifier = overlay
        .get("identifier")
        .unwrap_or(&base["identifier"])
        .as_str()
        .expect("Tauri identifier");
    assert_eq!(
        identifier, "es.egdev.quorb",
        "Unsupported Quorb build identity"
    );
    println!("cargo:rustc-env=QUORB_IDENTIFIER={identifier}");
    tauri_build::build()
}
