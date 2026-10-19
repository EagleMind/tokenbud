//! What every engine works with: a prompt to answer, and the answer.

use tokenbud_core::types::Turn;

/// A prompt to answer, with the chat so far.
pub struct Job {
    /// Comes from the relay; checked with [`valid_job_id`] before use.
    pub id: String,
    pub prompt: String,
    pub history: Vec<Turn>,
    /// The asker's saved memory, sent as a system prompt.
    pub context: Option<String>,
}

/// What answered, plus Claude Code's cost estimate when it gives one.
#[derive(Debug)]
pub struct Answer {
    pub text: String,
    pub cost_usd: Option<f64>,
}

/// Job IDs come from the relay and end up in folder names (the Claude Code sandbox), so only
/// plain IDs are accepted: a custom or compromised relay must not be able to point at a path.
pub fn valid_job_id(id: &str) -> bool {
    (1..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_plain_job_ids() {
        assert!(valid_job_id("j_AbC-123"));
        assert!(!valid_job_id(""));
        assert!(!valid_job_id("../../etc"));
        assert!(!valid_job_id("C:\\Users\\x"));
        assert!(!valid_job_id("/home/x"));
        assert!(!valid_job_id(&"a".repeat(65)));
    }
}
