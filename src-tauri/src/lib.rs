pub mod chat;
pub mod db;
#[cfg(feature = "desktop")]
pub mod desktop;
pub mod layout;
pub mod mcp;
mod proposals;
pub mod server;
#[path = "../setup.rs"]
pub mod setup;

pub type Result<T> = std::result::Result<T, AppError>;

#[derive(Debug, Clone)]
pub struct AppError {
    pub status: u16,
    pub message: String,
}

impl AppError {
    pub fn new(status: u16, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }
}
impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for AppError {}
impl From<std::io::Error> for AppError {
    fn from(error: std::io::Error) -> Self {
        Self::new(500, error.to_string())
    }
}
impl From<rusqlite::Error> for AppError {
    fn from(error: rusqlite::Error) -> Self {
        Self::new(500, error.to_string())
    }
}
impl From<serde_json::Error> for AppError {
    fn from(error: serde_json::Error) -> Self {
        Self::new(400, error.to_string())
    }
}
impl axum::response::IntoResponse for AppError {
    fn into_response(self) -> axum::response::Response {
        (
            axum::http::StatusCode::from_u16(self.status)
                .unwrap_or(axum::http::StatusCode::INTERNAL_SERVER_ERROR),
            axum::Json(serde_json::json!({"error": self.message})),
        )
            .into_response()
    }
}
