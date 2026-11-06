use std::{fs, path::Path};

fn copy_tree(from: &Path, to: &Path) {
    fs::create_dir_all(to).expect("create web resource directory");
    for entry in fs::read_dir(from).expect("read web resources") {
        let entry = entry.expect("read web resource");
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_tree(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), target).expect("copy web resource");
        }
    }
}

fn main() {
    for path in [
        "../index.html",
        "../assets/layout.js",
        "../assets",
        "status.html",
        "bridge.js",
    ] {
        println!("cargo:rerun-if-changed={path}");
    }
    fs::create_dir_all("web").unwrap();
    let html = fs::read_to_string("../index.html").unwrap();
    fs::write(
        "web/index.html",
        html.replacen("</head>", "<script src=\"/bridge.js\"></script></head>", 1),
    )
    .unwrap();
    fs::copy("../assets/layout.js", "web/layout.js").unwrap();
    let status = fs::read_to_string("status.html").unwrap();
    fs::write(
        "web/status.html",
        status.replacen("</head>", "<script src=\"/bridge.js\"></script></head>", 1),
    )
    .unwrap();
    fs::copy("bridge.js", "web/bridge.js").unwrap();
    copy_tree(Path::new("../assets"), Path::new("web/assets"));
    if std::env::var_os("CARGO_FEATURE_DESKTOP").is_some() {
        tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&[
                "get_state",
                "save_settings",
                "service",
                "open_client",
                "clear_apply_error",
                "pick_directory",
                "open_log_folder",
                "open_settings",
                "renderer_ready",
            ]),
        ))
        .expect("build Tauri command permissions");
    }
}
