#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let db = std::env::var_os("WALL_DB")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| "data/wall.db".into());
    let port: u16 = std::env::var("WALL_PORT")
        .unwrap_or_else(|_| "3000".into())
        .parse()?;
    let mcp = std::env::current_exe()?.with_file_name(if cfg!(windows) {
        "casegraph-mcp.exe"
    } else {
        "casegraph-mcp"
    });
    let server = casegraph::server::start(db, port, None, mcp).await?;
    println!("WALL_READY {}", server.port);
    tokio::signal::ctrl_c().await?;
    server.stop().await;
    Ok(())
}
