//! Small text helpers shared by the host, the client and the relay client.

use serde_json::Value;

/// At most `max_chars` characters of `s`, with "…" when cut. Counts characters, not bytes,
/// so it never splits one.
pub fn preview(s: &str, max_chars: usize) -> String {
    let mut out: String = s.chars().take(max_chars).collect();
    if s.chars().count() > max_chars {
        out.push('…');
    }
    out
}

/// `text` without any `<tag>…</tag>` sections. An unclosed tag drops everything after it
/// (a model that was cut off mid-section).
pub fn strip_tag(text: &str, tag: &str) -> String {
    let (open, close) = (format!("<{tag}>"), format!("</{tag}>"));
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find(&open) {
        out.push_str(&rest[..start]);
        rest = match rest[start..].find(&close) {
            Some(end) => &rest[start + end + close.len()..],
            None => "",
        };
    }
    out.push_str(rest);
    out.trim().to_string()
}

/// The human-readable message in an API error body: `{"error": {"message": …}}` or `{"error": "…"}`.
pub fn error_message(body: &Value) -> Option<String> {
    body["error"]["message"].as_str().or(body["error"].as_str()).map(str::to_string)
}

/// An error and its causes on one line, like `{:#}`, but without repeating a cause whose text
/// the error already includes (network errors often do).
pub fn error_chain(e: &anyhow::Error) -> String {
    let mut out = String::new();
    for cause in e.chain() {
        let text = cause.to_string();
        if !out.contains(&text) {
            if !out.is_empty() {
                out.push_str(": ");
            }
            out.push_str(&text);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn strips_tags() {
        assert_eq!(strip_tag("<think>hmm</think>\nHello", "think"), "Hello");
        assert_eq!(strip_tag("Hi <think>unfinished", "think"), "Hi");
        assert_eq!(strip_tag("a <r>x</r> b <r>y</r> c", "r"), "a  b  c");
        assert_eq!(strip_tag("plain", "think"), "plain");
    }

    #[test]
    fn previews_by_character() {
        assert_eq!(preview("héllo", 3), "hél…");
        assert_eq!(preview("hi", 3), "hi");
        assert_eq!(preview("😀😀😀😀", 2), "😀😀…");
    }

    #[test]
    fn reads_error_messages() {
        assert_eq!(error_message(&json!({"error": {"message": "bad key"}})).as_deref(), Some("bad key"));
        assert_eq!(error_message(&json!({"error": "nope"})).as_deref(), Some("nope"));
        assert_eq!(error_message(&json!({"ok": true})), None);
    }

    #[test]
    fn joins_error_causes_once() {
        let io = std::io::Error::other("connection refused");
        let e = anyhow::Error::new(io).context("IO error: connection refused").context("could not connect");
        assert_eq!(error_chain(&e), "could not connect: IO error: connection refused");
        assert_eq!(error_chain(&anyhow::anyhow!("plain")), "plain");
    }
}
