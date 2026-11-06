#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() {
    if std::env::args().nth(1).as_deref() == Some("--installer") {
        let result = tokio::runtime::Runtime::new().unwrap().block_on(casegraph::setup::command());
        if let Err(error) = result {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }
    casegraph::desktop::run();
}
