use std::fmt;

#[derive(Debug)]
pub enum CodecError {
    Io(std::io::Error),
    Format(String),
    Lz4(String),
    Protobuf(String),
    UnsupportedVersion(u32),
}

impl fmt::Display for CodecError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CodecError::Io(error) => write!(formatter, "io error: {error}"),
            CodecError::Format(message) => write!(formatter, "map format error: {message}"),
            CodecError::Lz4(message) => write!(formatter, "lz4 error: {message}"),
            CodecError::Protobuf(message) => write!(formatter, "protobuf error: {message}"),
            CodecError::UnsupportedVersion(version) => {
                write!(formatter, "unsupported WorldSerialization version {version}")
            }
        }
    }
}

impl std::error::Error for CodecError {}

impl From<std::io::Error> for CodecError {
    fn from(error: std::io::Error) -> Self {
        CodecError::Io(error)
    }
}

pub type Result<T> = std::result::Result<T, CodecError>;
