#[tokio::main]
async fn main() {
    if let Err(error) = casegraph::mcp::run().await {
        eprintln!("MCP startup failed: {error}");
        std::process::exit(1);
    }
}
