//! Auto-Mode: pick the cleanup style from the focused application, the active
//! browser-tab URL, and the window title (port of auto_mode.py, hardened
//! 2026-06). Match order: user overrides (substring on app / url / title) →
//! curated APP names → curated browser DOMAINS → curated TITLE substrings →
//! default.
//!
//! The app name is the most robust signal (a native app is unambiguous). For
//! browsers the app name is just "Safari" / "Google Chrome" / … — useless for
//! style selection — so the active tab URL (probed via AppleScript on macOS,
//! see inject.rs) is the precise signal: it tells Gmail from ChatGPT from
//! Google Docs even when the window title is unreadable. The title is the
//! last-resort signal (varies per document; on macOS needs Screen-Recording).

use std::collections::HashMap;

// Curated app-name → style map (substring match on the lowercased app name —
// macOS kCGWindowOwnerName / Linux WM_CLASS). Entries are chosen so substring
// stays safe ("code" intentionally also hits Xcode/VSCodium).
const CURATED_APPS: &[(&[&str], &str)] = &[
    (
        &[
            "claude", "chatgpt", "cursor", "windsurf", "code", "zed", "sublime", "jetbrains",
            "intellij", "pycharm", "webstorm", "goland", "clion", "rider", "phpstorm", "rubymine",
            "datagrip", "android studio", "rstudio", "fleet", "nova", "bbedit", "textmate",
            "emacs",
            "terminal", "iterm", "warp", "ghostty", "alacritty", "kitty", "konsole", "hyper",
            "wezterm", "tabby", "rio", "neovim", "nvim",
            // Windows shell exes (capture_active_window now yields the process exe
            // name on Windows): "WindowsTerminal" is caught by "terminal";
            // powershell/pwsh/cmd (also Cmder) are not, so list them explicitly.
            "powershell", "pwsh", "cmd",
        ],
        "prompt",
    ),
    (
        &[
            "mail", "outlook", "thunderbird", "spark", "superhuman", "mimestream", "canary",
            "mailspring", "airmail", "postbox", "em client", "newton",
        ],
        "email",
    ),
    (
        &[
            "slack", "discord", "telegram", "whatsapp", "teams", "signal", "messages",
            "mattermost", "beeper", "zulip", "skype", "viber", "messenger",
        ],
        "slack",
    ),
    (
        &[
            "word", "pages", "notion", "obsidian", "craft", "libreoffice", "openoffice",
            "confluence", "scrivener", "ulysses", "ia writer", "typora", "marktext", "onlyoffice",
            "wps", "abiword",
        ],
        "formal",
    ),
    // Quick-note apps → terse bullet notes.
    (&["bear", "joplin", "simplenote"], "notes"),
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

// Curated browser-DOMAIN → style map (substring match on the lowercased active
// tab URL). This is the precise per-browser signal — on macOS the URL is probed
// via AppleScript (inject.rs) because the window title is unreadable there, so a
// browser would otherwise always fall to `default`. Entries are full enough to
// avoid false hits ("mail.google" not "mail", "x.com/compose" not "x.com").
const CURATED_DOMAINS: &[(&[&str], &str)] = &[
    // AI chats / coding-in-browser → structured prompt rewrite
    (
        &[
            "claude.ai", "chatgpt.com", "chat.openai.com", "gemini.google.com", "aistudio.google",
            "perplexity.ai", "copilot.microsoft.com", "github.com/copilot", "x.ai", "grok.com",
            "poe.com", "deepseek.com", "chat.mistral", "phind.com", "t3.chat", "you.com",
            "huggingface.co/chat", "v0.dev", "v0.app", "bolt.new", "lovable.dev", "replit.com",
            "codesandbox.io", "stackblitz.com", "github.dev", "vscode.dev",
            "colab.research.google.com",
        ],
        "prompt",
    ),
    // Webmail → polite email body
    (
        &[
            "mail.google.com", "outlook.office.com", "outlook.live.com", "outlook.office365.com",
            "mail.proton.me", "mail.yahoo.com", "fastmail.com", "hey.com", "mail.zoho.com",
            "icloud.com/mail", "tutanota.com", "tuta.com", "posteo.de", "mailbox.org", "gmx.net",
        ],
        "email",
    ),
    // Web chat → short casual message
    (
        &[
            "app.slack.com", "web.whatsapp.com", "discord.com/channels", "web.telegram.org",
            "teams.microsoft.com", "teams.live.com", "messenger.com", "chat.google.com",
            "web.skype.com", "element.io",
        ],
        "slack",
    ),
    // Docs / collaborative writing → formal tone
    (
        &[
            "docs.google.com", "notion.so", "notion.site", "coda.io", "confluence",
            "office.com/launch/word", "word-edit.officeapps", "quip.com", "craft.do", "slite.com",
            "dropbox.com/scl", "nuclino.com",
        ],
        "formal",
    ),
    // Dedicated social-post composers → punchy social style (unambiguous tools
    // only — a generic linkedin.com/x.com URL is too often just browsing/DMs).
    (
        &[
            "typefully.com", "buffer.com", "hootsuite.com", "x.com/compose", "tweetdeck",
            "publer.io", "hypefury.com",
        ],
        "social",
    ),
    // Web note apps → terse notes
    (&["keep.google.com", "notes.google"], "notes"),
];

/// Pick the cleanup style for the focused `app`, active browser-tab `url`, and
/// window `title`. Returns the style plus which rule decided it ("override" |
/// "app" | "url" | "title" | "default") so the decision is diagnosable from the
/// logs. `url` is empty on Win/Linux and for non-browsers (see inject.rs).
///
/// Match order is precision-ranked: a native app is unambiguous (highest), then
/// the browser domain (the precise in-browser signal), then the title (varies /
/// often empty on macOS), then the default.
pub fn pick_style(
    app: &str,
    url: &str,
    title: &str,
    overrides: &HashMap<String, String>,
    default: &str,
) -> (String, &'static str) {
    let a = app.to_lowercase();
    let u = url.to_lowercase();
    let t = title.to_lowercase();
    for (sub, style) in overrides {
        if sub.is_empty() {
            continue;
        }
        let s = sub.to_lowercase();
        if a.contains(&s) || u.contains(&s) || t.contains(&s) {
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
    if !u.is_empty() {
        for (subs, style) in CURATED_DOMAINS {
            if subs.iter().any(|s| u.contains(s)) {
                return (style.to_string(), "url");
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

    // app + title (no browser URL) — the common Win/Linux + native-app case.
    fn style(app: &str, title: &str, ov: &HashMap<String, String>) -> String {
        pick_style(app, "", title, ov, "default").0
    }
    // browser app + active-tab URL (the macOS browser case).
    fn url_style(app: &str, url: &str) -> (String, &'static str) {
        pick_style(app, url, "", &HashMap::new(), "default")
    }

    #[test]
    fn test_default_fallback() {
        let overrides = HashMap::new();
        assert_eq!(style("", "Some Random Window", &overrides), "default");
        assert_eq!(pick_style("", "", "Some Random Window", &overrides, "default").1, "default");
    }

    #[test]
    fn test_browser_url_matching() {
        // macOS browsers: app name is useless ("Safari"), title is empty without
        // Screen-Recording — the active-tab URL is the deciding signal.
        assert_eq!(url_style("Safari", "https://claude.ai/chat/abc"), ("prompt".into(), "url"));
        assert_eq!(url_style("Google Chrome", "https://chatgpt.com/c/1"), ("prompt".into(), "url"));
        assert_eq!(
            url_style("Google Chrome", "https://mail.google.com/mail/u/0/#inbox"),
            ("email".into(), "url")
        );
        assert_eq!(
            url_style("Arc", "https://docs.google.com/document/d/x/edit"),
            ("formal".into(), "url")
        );
        assert_eq!(
            url_style("Google Chrome", "https://app.slack.com/client/T/C"),
            ("slack".into(), "url")
        );
        assert_eq!(
            url_style("Safari", "https://typefully.com/compose"),
            ("social".into(), "url")
        );
        // An un-mapped site falls through to default (not a wrong style).
        assert_eq!(url_style("Safari", "https://news.ycombinator.com"), ("default".into(), "default"));
    }

    #[test]
    fn test_app_beats_url_when_both_present() {
        // A native app's own name wins over any stray URL signal.
        assert_eq!(
            pick_style("Cursor", "https://mail.google.com", "", &HashMap::new(), "default"),
            ("prompt".into(), "app")
        );
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
        assert_eq!(pick_style("Mail", "", "", &overrides, "default"), ("email".into(), "app"));
        assert_eq!(style("Cursor", "", &overrides), "prompt");
        assert_eq!(style("Xcode", "", &overrides), "prompt"); // "code" substring, intended
        assert_eq!(style("Microsoft Teams", "", &overrides), "slack");
        assert_eq!(style("Microsoft Word", "", &overrides), "formal");
        assert_eq!(style("Claude", "", &overrides), "prompt");
        // New styles via curated apps.
        assert_eq!(style("Bear", "", &overrides), "notes");
        assert_eq!(style("Ulysses", "", &overrides), "formal");
    }

    #[test]
    fn test_windows_exe_app_names() {
        // On Windows capture_active_window now yields the process exe basename
        // (lowercased, ".exe" stripped) — exercise the app-rule path with those.
        let ov = HashMap::new();
        assert_eq!(style("code", "", &ov), "prompt"); // Code.exe
        assert_eq!(style("cursor", "", &ov), "prompt"); // Cursor.exe
        assert_eq!(style("windowsterminal", "", &ov), "prompt"); // → contains "terminal"
        assert_eq!(style("powershell", "", &ov), "prompt"); // powershell.exe
        assert_eq!(style("pwsh", "", &ov), "prompt"); // PowerShell 7
        assert_eq!(style("cmd", "", &ov), "prompt"); // cmd.exe
        assert_eq!(style("outlook", "", &ov), "email"); // outlook.exe
        assert_eq!(style("slack", "", &ov), "slack"); // slack.exe
        assert_eq!(style("winword", "", &ov), "formal"); // winword.exe → contains "word"
        // Browsers report their own exe → no app rule fires; the tab title decides.
        assert_eq!(style("chrome", "", &ov), "default");
        assert_eq!(style("chrome", "ChatGPT - Google Chrome", &ov), "prompt");
        assert_eq!(style("msedge", "Posteingang - Outlook", &ov), "email");
    }

    #[test]
    fn test_app_wins_over_title() {
        // The app is the robust signal: a doc titled "slack notes" in Word is formal.
        let overrides = HashMap::new();
        assert_eq!(
            pick_style("Microsoft Word", "", "slack notes.docx", &overrides, "default"),
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
        assert_eq!(pick_style("Mail", "", "", &by_app, "default"), ("custom".into(), "override"));
        // Overrides match the browser URL too.
        let mut by_url = HashMap::new();
        by_url.insert("linear.app".to_string(), "notes".to_string());
        assert_eq!(
            pick_style("Safari", "https://linear.app/team/issue", "", &by_url, "default"),
            ("notes".into(), "override")
        );
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
