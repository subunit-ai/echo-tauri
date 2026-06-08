// Light/Dark toggle — mirrors the vanilla `toggleTheme()`: flips html.dark, persists
// the choice, and keeps the iOS status-bar theme-color in sync. The moon/sun icon swap
// is pure CSS (--tg-moon / --tg-sun flip with html.dark), so no React state needed.
export function isDark(): boolean {
  return document.documentElement.classList.contains("dark");
}

export function applyTheme(dark: boolean): void {
  document.documentElement.classList.toggle("dark", dark);
  try {
    localStorage.setItem("meet-theme", dark ? "dark" : "light");
  } catch {
    /* private mode — ignore */
  }
  const m = document.getElementById("theme-color-meta");
  if (m) m.setAttribute("content", dark ? "#071427" : "#f4f8fd");
}

export function toggleTheme(): void {
  applyTheme(!isDark());
}
