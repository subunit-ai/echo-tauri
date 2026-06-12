//! Auto-Mode: pick the cleanup style from the focused application + window
//! title (port of auto_mode.py, hardened 2026-06). Match order: user overrides
//! (substring on app or title) → curated APP names → curated TITLE substrings
//! → default. The app name is the robust signal — titles vary per document and
//! on macOS are only readable with the Screen-Recording permission.

use std::collections::HashMap;

// Curated app-name → style map (substring match on the lowercased app name —
// macOS kCGWindowOwnerName / Linux WM_CLASS). Entries are chosen so substring
// stays safe ("code" intentionally also hits Xcode/VSCodium).
const CURATED_APPS: &[(&[&str], &str)] = &[
    (
        &[
            "claude", "chatgpt", "cursor", "windsurf", "code", "zed", "sublime", "jetbrains",
            "intellij", "pycharm", "webstorm", "goland", "clion", "rider", "phpstorm",
            "terminal", "iterm", "warp", "ghostty", "alacritty", "kitty", "konsole", "hyper",
            "neovim", "nvim",
        ],
        "prompt",
    ),
    (
        &[
            "mail", "outlook", "thunderbird", "spark", "superhuman", "mimestream", "canary",
        ],
        "email",
    ),
    (
        &[
            "slack", "discord", "telegram", "whatsapp", "teams", "signal", "messages",
            "mattermost", "beeper",
        ],
        "slack",
    ),
    (
        &[
            "word", "pages", "notion", "obsidian", "craft", "libreoffice", "openoffice",
            "confluence",
        ],
        "formal",
    ),
];

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

/// Pick the cleanup style for the focused `app` + window `title`. Returns the
/// style plus which rule decided it ("override" | "app" | "title" | "default")
/// so the decision is diagnosable from the logs.
pub fn pick_style(
    app: &str,
    title: &str,
    overrides: &HashMap<String, String>,
    default: &str,
) -> (String, &'static str) {
    let a = app.to_lowercase();
    let t = title.to_lowercase();
    for (sub, style) in overrides {
        if sub.is_empty() {
            continue;
        }
        let s = sub.to_lowercase();
        if a.contains(&s) || t.contains(&s) {
            return (style.clone(), "override");
        }
    }
    if !a.is_empty() {
        for (subs, style) in CURATED_APPS {
            if subs.iter().any(|s| a.contains(s)) {
                return (style.to_string(), "app");
            }
        }
    }
    for (subs, style) in CURATED {
        if subs.iter().any(|s| t.contains(s)) {
            return (style.to_string(), "title");
        }
    }
    (default.to_string(), "default")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn style(app: &str, title: &str, ov: &HashMap<String, String>) -> String {
        pick_style(app, title, ov, "default").0
    }

    #[test]
    fn test_default_fallback() {
        let overrides = HashMap::new();
        assert_eq!(style("", "Some Random Window", &overrides), "default");
        assert_eq!(pick_style("", "Some Random Window", &overrides, "default").1, "default");
    }

    #[test]
    fn test_curated_title_matching() {
        let overrides = HashMap::new();
        assert_eq!(style("", "Google Docs - Document", &overrides), "formal");
        assert_eq!(style("", "Visual Studio Code", &overrides), "prompt");
        assert_eq!(style("", "Slack | General", &overrides), "slack");
    }

    #[test]
    fn test_curated_app_matching() {
        let overrides = HashMap::new();
        // macOS app names — no title needed (Screen-Recording permission absent).
        assert_eq!(pick_style("Mail", "", &overrides, "default"), ("email".into(), "app"));
        assert_eq!(style("Cursor", "", &overrides), "prompt");
        assert_eq!(style("Xcode", "", &overrides), "prompt"); // "code" substring, intended
        assert_eq!(style("Microsoft Teams", "", &overrides), "slack");
        assert_eq!(style("Microsoft Word", "", &overrides), "formal");
        assert_eq!(style("Claude", "", &overrides), "prompt");
    }

    #[test]
    fn test_app_wins_over_title() {
        // The app is the robust signal: a doc titled "slack notes" in Word is formal.
        let overrides = HashMap::new();
        assert_eq!(
            pick_style("Microsoft Word", "slack notes.docx", &overrides, "default"),
            ("formal".into(), "app")
        );
    }

    #[test]
    fn test_override_precedence() {
        let mut overrides = HashMap::new();
        overrides.insert("docs".to_string(), "custom".to_string());
        assert_eq!(style("", "Google Docs", &overrides), "custom");
        // Overrides match the app name too.
        let mut by_app = HashMap::new();
        by_app.insert("mail".to_string(), "custom".to_string());
        assert_eq!(pick_style("Mail", "", &by_app, "default"), ("custom".into(), "override"));
    }

    #[test]
    fn test_case_insensitivity() {
        let mut overrides = HashMap::new();
        overrides.insert("MYAPP".to_string(), "uppercase".to_string());
        assert_eq!(style("", "using myapp today", &overrides), "uppercase");
        assert_eq!(style("", "GOOGLE DOCS", &HashMap::new()), "formal");
        assert_eq!(style("SLACK", "", &HashMap::new()), "slack");
    }

    #[test]
    fn test_empty_overrides_ignored() {
        let mut overrides = HashMap::new();
        overrides.insert("".to_string(), "empty".to_string());
        assert_eq!(style("", "Some Title", &overrides), "default");
    }
}
