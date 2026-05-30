// i18n bootstrap. German is the source language + fallback; English is the
// second market language. Components use `useTranslation()` → `t("ns.key")`.
// Language follows config.ui_language (synced from ConfigContext on load + the
// Settings picker), so a switch re-renders the whole UI instantly.
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import de from "./locales/de.json";
import en from "./locales/en.json";

export const SUPPORTED_LANGUAGES: { code: string; label: string }[] = [
  { code: "de", label: "Deutsch" },
  { code: "en", label: "English" },
];

i18n.use(initReactI18next).init({
  resources: {
    de: { translation: de },
    en: { translation: en },
  },
  lng: "de",
  fallbackLng: "de",
  supportedLngs: ["de", "en"],
  interpolation: { escapeValue: false }, // React already escapes
  returnNull: false,
});

/** Switch the UI language (no-op for unsupported codes). */
export function setLanguage(code: string) {
  const lng = code === "en" ? "en" : "de";
  if (i18n.language !== lng) void i18n.changeLanguage(lng);
}

export default i18n;
