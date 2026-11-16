import { EN, type PluralTranslation, type TranslationEntry, type TranslationValues } from "./i18n-en.ts";

export type Locale = "zh-CN" | "en";
export type { PluralTranslation, TranslationEntry, TranslationValues };

let activeLocale: Locale = "zh-CN";

/** 前端、服务端各自的英文词条在启动时并进来（见 web/src/i18n/en、server/src/i18n/en）。 */
export function addEnglish(entries: Record<string, TranslationEntry>): void {
  Object.assign(EN, entries);
}

export function setLocale(locale: Locale): void {
  activeLocale = locale;
}

export function currentLocale(): Locale {
  return activeLocale;
}

function replaceValues(text: string, values: TranslationValues): string {
  return text.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (whole, key: string) => {
    const value = values[key];
    return value === undefined ? whole : String(value);
  });
}

/** Translate a Chinese source string. Missing English entries intentionally fall back to Chinese. */
export function t(source: string, values: TranslationValues = {}, locale: Locale = activeLocale): string {
  if (locale === "zh-CN") return replaceValues(source, values);
  const entry: TranslationEntry | undefined = EN[source];
  if (!entry) return replaceValues(source, values);
  if (typeof entry === "string") return replaceValues(entry, values);
  const n = Number(values.n ?? 0);
  const plural = new Intl.PluralRules("en").select(n);
  return replaceValues((plural === "one" ? entry.one : entry.other), values);
}

export function localeFromBrowser(languages: readonly string[] = []): Locale {
  // 只看浏览器的首选语言：英文为先、中文排第二的人想要的是英文
  return languages[0]?.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

export function localeName(locale: Locale): string {
  return locale === "en" ? "English" : "中文";
}
