//! Auto-Mode: pick the cleanup style from the active window title (port of
//! auto_mode.py). User overrides (substring → style) win over the curated map.

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

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn test_default_fallback() {
        let overrides = HashMap::new();
        assert_eq!(pick_style("Some Random Window", &overrides, "default"), "default");
    }

    #[test]
    fn test_curated_matching() {
        let overrides = HashMap::new();
        assert_eq!(pick_style("Google Docs - Document", &overrides, "default"), "formal");
        assert_eq!(pick_style("Visual Studio Code", &overrides, "default"), "prompt");
        assert_eq!(pick_style("Slack | General", &overrides, "default"), "slack");
    }

    #[test]
    fn test_override_precedence() {
        let mut overrides = HashMap::new();
        overrides.insert("docs".to_string(), "custom".to_string());

        assert_eq!(pick_style("Google Docs", &overrides, "default"), "custom");
    }

    #[test]
    fn test_case_insensitivity() {
        let mut overrides = HashMap::new();
        overrides.insert("MYAPP".to_string(), "uppercase".to_string());

        assert_eq!(pick_style("using myapp today", &overrides, "default"), "uppercase");
        assert_eq!(pick_style("GOOGLE DOCS", &HashMap::new(), "default"), "formal");
    }

    #[test]
    fn test_empty_overrides_ignored() {
        let mut overrides = HashMap::new();
        overrides.insert("".to_string(), "empty".to_string());

        assert_eq!(pick_style("Some Title", &overrides, "default"), "default");
    }
}
