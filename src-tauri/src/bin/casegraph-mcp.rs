#[tokio::main]
async fn main() {
    if std::env::args().nth(1).as_deref() == Some("--installer") {
        if let Err(error) = casegraph::setup::command().await {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }
    if let Err(error) = casegraph::mcp::run().await {
        eprintln!("MCP startup failed: {error}");
        std::process::exit(1);
    }
}
