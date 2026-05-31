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
            "claude",
            "chatgpt",
            "chat.openai",
            "openai",
            "gemini",
            "perplexity",
            "copilot",
            "cursor",
            "vs code",
            "vscode",
            "vscodium",
            "visual studio code",
            "jetbrains",
            "intellij",
            "pycharm",
            "webstorm",
            "goland",
            "rubymine",
            "clion",
            "rider",
            "phpstorm",
            "datagrip",
            "sublime text",
            "zed",
            "neovim",
            "nvim",
            "terminal",
            "iterm",
            "konsole",
            "alacritty",
            "kitty",
            "hyper",
            "powershell",
            "eingabeaufforderung",
            "cmd.exe",
        ],
        "prompt",
    ),
    // Mail clients → polite email body
    (
        &[
            "gmail",
            "outlook",
            "apple mail",
            "mail —",
            "posteingang",
            "thunderbird",
            "spark mail",
            "protonmail",
            "proton.me",
            "fastmail",
            "hey.com",
            "superhuman",
        ],
        "email",
    ),
    // Chat apps → short casual message
    (
        &[
            "slack",
            "discord",
            "telegram",
            "whatsapp",
            "microsoft teams",
            "teams.microsoft",
            "signal",
            "imessage",
            "messages —",
            "mattermost",
            "rocket.chat",
        ],
        "slack",
    ),
    // Documents / business writing → formal tone
    (
        &[
            "word",
            ".docx",
            "libreoffice writer",
            "openoffice writer",
            "google docs",
            "docs.google",
            "notion",
            "pages",
            "confluence",
            "obsidian",
        ],
        "formal",
    ),
];

pub fn pick_style(title: &str, overrides: &HashMap<String, String>, default: &str) -> String {
    let t = title.to_lowercase();
    for (sub, style) in overrides {
        if !sub.is_empty() && t.contains(sub) {
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
