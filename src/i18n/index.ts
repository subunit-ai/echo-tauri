// i18n bootstrap. German is the source language; English is the universal
// fallback. Components use `useTranslation()` → `t("ns.key")`. Language follows
// config.ui_language (synced from ConfigContext on load + the Settings picker).
//
// Scaling to "every language": locales are auto-discovered from ./locales/*.json
// and LAZY-loaded — only de + en are bundled (fallback + instant first paint);
// any other language's catalog is fetched as its own chunk the first time it's
// selected. Adding a language = dropping a JSON file here; no code change.
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import de from "./locales/de.json";
import en from "./locales/en.json";

// Lazy loaders for every locale catalog (not eager → each is a separate chunk).
const lazy = import.meta.glob("./locales/*.json");
const loaders: Record<string, () => Promise<{ default: Record<string, unknown> }>> = {};
for (const [path, loader] of Object.entries(lazy)) {
  const code = path.replace(/^.*\/(.+)\.json$/, "$1");
  loaders[code] = loader as () => Promise<{ default: Record<string, unknown> }>;
}

// Native endonyms for every Whisper-supported UI language (see lib/languages.ts).
// Labels whichever locales are actually present. Falls back to the code.
export const NATIVE_NAMES: Record<string, string> = {
  de: "Deutsch", en: "English", fr: "Français", es: "Español", it: "Italiano",
  nl: "Nederlands", pt: "Português", pl: "Polski", ru: "Русский", uk: "Українська",
  cs: "Čeština", tr: "Türkçe", sv: "Svenska", da: "Dansk", no: "Norsk",
  fi: "Suomi", el: "Ελληνικά", hu: "Magyar", ro: "Română", bg: "Български",
  hr: "Hrvatski", sk: "Slovenčina", sl: "Slovenščina", ca: "Català", ar: "العربية",
  he: "עברית", hi: "हिन्दी", ja: "日本語", ko: "한국어", zh: "中文",
  th: "ไทย", vi: "Tiếng Việt", id: "Bahasa Indonesia", ms: "Bahasa Melayu", fa: "فارسی",
  ur: "اردو", ta: "தமிழ்", te: "తెలుగు", bn: "বাংলা", et: "Eesti",
  lv: "Latviešu", lt: "Lietuvių", is: "Íslenska", mt: "Malti", cy: "Cymraeg",
  ga: "Gaeilge", sr: "Српски", mk: "Македонски", sq: "Shqip", af: "Afrikaans",
  sw: "Kiswahili", az: "Azərbaycanca", kk: "Қазақша", hy: "Հայերեն", be: "Беларуская",
  bs: "Bosanski", gl: "Galego", eu: "Euskara", br: "Brezhoneg", oc: "Occitan",
  lb: "Lëtzebuergesch", fo: "Føroyskt", nn: "Nynorsk", la: "Latina", sa: "संस्कृतम्",
  ne: "नेपाली", mr: "मराठी", pa: "ਪੰਜਾਬੀ", gu: "ગુજરાતી", kn: "ಕನ್ನಡ",
  ml: "മലയാളം", si: "සිංහල", as: "অসমীয়া", sd: "سنڌي", my: "မြန်မာ",
  km: "ខ្មែរ", lo: "ລາວ", bo: "བོད་སྐད་", mn: "Монгол", ka: "ქართული",
  tg: "Тоҷикӣ", uz: "Oʻzbekcha", tk: "Türkmençe", tt: "Татарча", ba: "Башҡортса",
  ps: "پښتو", yi: "ייִדיש", am: "አማርኛ", yue: "粵語", tl: "Tagalog",
  jw: "Basa Jawa", su: "Basa Sunda", mi: "Māori", haw: "ʻŌlelo Hawaiʻi", mg: "Malagasy",
  sn: "ChiShona", yo: "Yorùbá", so: "Soomaali", ha: "Hausa", ln: "Lingála",
  ht: "Kreyòl Ayisyen",
};

// Right-to-left scripts — the document direction flips for these.
const RTL = new Set(["ar", "he", "fa", "ur", "ps", "yi", "sd"]);

// The languages actually shipped (whatever catalogs exist), sorted by native name
// with German + English pinned first (primary markets).
export const SUPPORTED_LANGUAGES: { code: string; label: string }[] = Object.keys(
  loaders,
)
  .map((code) => ({ code, label: NATIVE_NAMES[code] ?? code }))
  .sort((a, b) => {
    const rank = (c: string) => (c === "de" ? 0 : c === "en" ? 1 : 2);
    return rank(a.code) - rank(b.code) || a.label.localeCompare(b.label);
  });

const supportedCodes = SUPPORTED_LANGUAGES.map((l) => l.code);

i18n.use(initReactI18next).init({
  resources: {
    de: { translation: de },
    en: { translation: en },
  },
  lng: "de",
  fallbackLng: "en", // English is the most universal fallback for any gaps
  supportedLngs: supportedCodes,
  interpolation: { escapeValue: false }, // React already escapes
  returnNull: false,
});

applyDir(i18n.language);
i18n.on("languageChanged", applyDir);

function applyDir(code: string) {
  if (typeof document === "undefined") return;
  document.documentElement.dir = RTL.has(code) ? "rtl" : "ltr";
  document.documentElement.lang = code;
}

/**
 * Switch the UI language. de/en are bundled; any other catalog is fetched on
 * first use, registered, then activated. Unknown codes fall back to German.
 */
export async function setLanguage(code: string): Promise<void> {
  const lng = supportedCodes.includes(code) ? code : "de";
  if (!i18n.hasResourceBundle(lng, "translation") && loaders[lng]) {
    try {
      const mod = await loaders[lng]();
      i18n.addResourceBundle(lng, "translation", mod.default ?? mod, true, true);
    } catch {
      return; // keep the current language if the chunk fails to load
    }
  }
  if (i18n.language !== lng) await i18n.changeLanguage(lng);
}

export default i18n;
