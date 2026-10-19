//! Local-first memory: facts about you that travel with each prompt (when enabled), and the small
//! rules for chats. The web client mirrors these in desktop/src/client/backend.ts; the shared
//! fixtures in tests/fixtures/memory.json keep the two in step.

use serde::{Deserialize, Serialize};
use tokenbud_core::text::strip_tag;
use tokenbud_core::types::{Role, Turn};

pub const MAX_FACTS: usize = 50;
pub const MAX_FACT_CHARS: usize = 300;
pub const MAX_CHATS: usize = 100;
/// Chat titles are the first line of the first prompt, cut to this many characters.
pub const TITLE_CHARS: usize = 48;
/// Suggestions answered "Not now" that are remembered (older ones are forgotten).
pub const MAX_DISMISSED: usize = 200;

const REMEMBER_TAG: &str = "remember";
const REMEMBER_INSTRUCTION: &str = "If they share a lasting fact about themselves or a preference worth remembering in \
future conversations, end your reply with <remember>one short fact, like \"Prefers short answers\"</remember> \
(at most two). Otherwise don't add it, and never mention these tags.";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Fact {
    pub id: String,
    pub text: String,
    pub at: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Memory {
    pub enabled: bool,
    pub facts: Vec<Fact>,
    /// Suggestions you said "Not now" to, so they aren't offered again.
    pub dismissed: Vec<String>,
}

impl Default for Memory {
    fn default() -> Self {
        Self { enabled: true, facts: vec![], dismissed: vec![] }
    }
}

impl Memory {
    /// The system prompt that carries your memory to the host's agent (None when memory is off).
    pub fn context(&self) -> Option<String> {
        if !self.enabled {
            return None;
        }
        let mut out = String::new();
        if !self.facts.is_empty() {
            out.push_str("What you know about the person asking, from their own saved notes:\n");
            for f in &self.facts {
                out.push_str(&format!("- {}\n", f.text));
            }
            out.push('\n');
        }
        out.push_str(REMEMBER_INSTRUCTION);
        Some(out)
    }

    /// Add a fact unless it's already there (case-insensitive). Errors are for people.
    pub fn add(&mut self, text: &str, id: String, at: i64) -> Result<(), String> {
        let text = clean_fact(text)?;
        if self.facts.iter().any(|f| f.text.eq_ignore_ascii_case(&text)) {
            return Ok(());
        }
        if self.facts.len() >= MAX_FACTS {
            return Err(format!("Memory holds up to {MAX_FACTS} facts. Remove one first."));
        }
        self.facts.push(Fact { id, text, at });
        Ok(())
    }

    pub fn dismiss(&mut self, text: &str) {
        let text: String = text.chars().take(MAX_FACT_CHARS).collect();
        if !self.dismissed.contains(&text) {
            self.dismissed.push(text);
            let excess = self.dismissed.len().saturating_sub(MAX_DISMISSED);
            self.dismissed.drain(..excess);
        }
    }
}

/// One line, trimmed, at most `MAX_FACT_CHARS` characters.
pub fn clean_fact(text: &str) -> Result<String, String> {
    let t = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.is_empty() {
        return Err("Write something to remember.".into());
    }
    Ok(t.chars().take(MAX_FACT_CHARS).collect())
}

/// Answers may end with <remember>…</remember> suggestions; the agent shouldn't see them again.
pub fn strip_remember(text: &str) -> String {
    strip_tag(text, REMEMBER_TAG)
}

/// A chat's title: the first non-empty line of its first prompt, cut by characters (never mid-emoji).
pub fn title_of(prompt: &str) -> String {
    let line = prompt.lines().find(|l| !l.trim().is_empty()).unwrap_or("New chat").trim();
    let mut t: String = line.chars().take(TITLE_CHARS).collect();
    if line.chars().count() > TITLE_CHARS {
        t.push('…');
    }
    t
}

/// The chat so far as turns for the host: answered exchanges only, without memory suggestions.
pub fn history<'a>(exchanges: impl IntoIterator<Item = (&'a str, Option<&'a str>)>) -> Vec<Turn> {
    exchanges
        .into_iter()
        .filter_map(|(prompt, answer)| answer.map(|a| (prompt, a)))
        .flat_map(|(prompt, answer)| {
            [Turn { role: Role::User, content: prompt.to_string() }, Turn { role: Role::Assistant, content: strip_remember(answer) }]
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    /// Shared with desktop/src/client/backend.test.ts, so the Rust and web clients behave alike.
    fn fixtures() -> Value {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../tests/fixtures/memory.json");
        serde_json::from_str(&std::fs::read_to_string(path).expect("tests/fixtures/memory.json")).unwrap()
    }

    #[test]
    fn titles_match_the_fixtures() {
        for case in fixtures()["titles"].as_array().unwrap() {
            assert_eq!(title_of(case["prompt"].as_str().unwrap()), case["title"].as_str().unwrap(), "{case}");
        }
    }

    #[test]
    fn context_matches_the_fixtures() {
        for case in fixtures()["contexts"].as_array().unwrap() {
            let memory: Memory = serde_json::from_value(case["memory"].clone()).unwrap();
            assert_eq!(memory.context().as_deref(), case["context"].as_str(), "{case}");
        }
    }

    #[test]
    fn history_keeps_only_answered_exchanges_without_suggestions() {
        let h = history([("q1", Some("a1\n<remember>Likes tea</remember>")), ("q2", None)]);
        assert_eq!(h.len(), 2);
        assert_eq!(h[1].content, "a1");
    }

    #[test]
    fn memory_rules() {
        let mut m = Memory::default();
        m.add("  Writes   Go ", "f1".into(), 0).unwrap();
        m.add("writes go", "f2".into(), 0).unwrap();
        assert_eq!(m.facts.len(), 1, "duplicates are case-insensitive");
        assert_eq!(m.facts[0].text, "Writes Go");
        assert!(m.add("   ", "f3".into(), 0).is_err());
        for i in 0..MAX_FACTS {
            let _ = m.add(&format!("fact {i}"), format!("x{i}"), 0);
        }
        assert!(m.add("one too many", "y".into(), 0).is_err());
        assert_eq!(clean_fact(&"x".repeat(400)).unwrap().chars().count(), MAX_FACT_CHARS);

        for i in 0..(MAX_DISMISSED + 5) {
            m.dismiss(&format!("s{i}"));
        }
        assert_eq!(m.dismissed.len(), MAX_DISMISSED);
        assert_eq!(m.dismissed.last().unwrap(), &format!("s{}", MAX_DISMISSED + 4));
    }

    #[test]
    fn old_saved_memory_still_loads() {
        let m: Memory = serde_json::from_str(r#"{"facts": []}"#).unwrap();
        assert!(m.enabled && m.dismissed.is_empty());
    }
}
