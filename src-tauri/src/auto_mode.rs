//! Auto-Mode: pick the cleanup style from the active window title (port of
//! auto_mode.py). User overrides (substring → style) win over the curated map.

use std::collections::HashMap;

const CURATED: &[(&[&str], &str)] = &[
    (&["claude", "chatgpt", "gpt", "gemini", "perplexity", "cursor", "copilot"], "prompt"),
    (&["outlook", "gmail", "mail", "thunderbird"], "email"),
    (&["slack", "teams", "discord", "whatsapp", "telegram"], "slack"),
    (&["word", "docs", "document", "notion", "pages", "libreoffice"], "formal"),
];

pub fn pick_style(title: &str, overrides: &HashMap<String, String>, default: &str) -> String {
    let t = title.to_lowercase();
    for (sub, style) in overrides {
        if !sub.is_empty() && t.contains(&sub.to_lowercase()) {
            return style.clone();
        }
    }
    for (subs, style) in CURATED {
        if subs.iter().any(|s| t.contains(s)) {
            return style.to_string();
        }
    }
    default.to_string()
}
