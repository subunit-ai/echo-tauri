//! Auto-Mode: pick the cleanup style from the active window title (port of
//! auto_mode.py). User overrides (substring → style) win over the curated map.

use once_cell::sync::Lazy;
use regex::RegexSet;
use std::collections::HashMap;

// Curated window-title → style map (substring match on the lowercased title;
// port of auto_mode.py's regex rules, broadened to cover the same apps). User
// overrides win over this.
const CURATED: &[(&[&str], &str)] = &[
    // AI chats, code editors, terminals → structured prompt rewrite
    (
        &[
            "claude", "chatgpt", "chat.openai", "openai", "gemini", "perplexity", "copilot",
            "cursor", "vs code", "vscode", "vscodium", "visual studio code", "jetbrains",
            "intellij", "pycharm", "webstorm", "goland", "rubymine", "clion", "rider",
            "phpstorm", "datagrip", "sublime text", "zed", "neovim", "nvim", "terminal",
            "iterm", "konsole", "alacritty", "kitty", "hyper", "powershell",
            "eingabeaufforderung", "cmd.exe",
        ],
        "prompt",
    ),
    // Mail clients → polite email body
    (
        &[
            "gmail", "outlook", "apple mail", "mail —", "posteingang", "thunderbird",
            "spark mail", "protonmail", "proton.me", "fastmail", "hey.com", "superhuman",
        ],
        "email",
    ),
    // Chat apps → short casual message
    (
        &[
            "slack", "discord", "telegram", "whatsapp", "microsoft teams", "teams.microsoft",
            "signal", "imessage", "messages —", "mattermost", "rocket.chat",
        ],
        "slack",
    ),
    // Documents / business writing → formal tone
    (
        &[
            "word", ".docx", "libreoffice writer", "openoffice writer", "google docs",
            "docs.google", "notion", "pages", "confluence", "obsidian",
        ],
        "formal",
    ),
];

static CURATED_REGEX_SET: Lazy<RegexSet> = Lazy::new(|| {
    let patterns = CURATED.iter().map(|(subs, _)| {
        subs.iter()
            .map(|s| regex::escape(s))
            .collect::<Vec<_>>()
            .join("|")
    });
    RegexSet::new(patterns).expect("Failed to compile CURATED_REGEX_SET")
});

pub fn pick_style(title: &str, overrides: &HashMap<String, String>, default: &str) -> String {
    let t = title.to_lowercase();
    for (sub, style) in overrides {
        if !sub.is_empty() && t.contains(&sub.to_lowercase()) {
            return style.clone();
        }
    }

    if let Some(matches) = CURATED_REGEX_SET.matches(&t).into_iter().next() {
        return CURATED[matches].1.to_string();
    }

    default.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn test_pick_style() {
        let mut overrides = HashMap::new();
        overrides.insert("my-custom-app".to_string(), "custom_style".to_string());

        assert_eq!(pick_style("Some my-custom-app Window", &overrides, "default"), "custom_style");
        assert_eq!(pick_style("chatgpt", &HashMap::new(), "default"), "prompt");
        assert_eq!(pick_style("Gmail - Inbox", &HashMap::new(), "default"), "email");
        assert_eq!(pick_style("Slack | random", &HashMap::new(), "default"), "slack");
        assert_eq!(pick_style("My cool document.docx - Word", &HashMap::new(), "default"), "formal");
        assert_eq!(pick_style("Unknown App", &HashMap::new(), "default"), "default");
    }

    #[test]
    fn bench_pick_style() {
        let overrides = HashMap::new();
        let titles = vec![
            "Some my-custom-app Window",
            "chatgpt",
            "Gmail - Inbox",
            "Slack | random",
            "My cool document.docx - Word",
            "Unknown App",
            "A very long window title that does not match anything in the curated list but we need to check everything",
        ];

        let start = Instant::now();
        for _ in 0..100_000 {
            for title in &titles {
                std::hint::black_box(pick_style(title, &overrides, "default"));
            }
        }
        let duration = start.elapsed();
        println!("Benchmark duration: {:?}", duration);
    }
}
