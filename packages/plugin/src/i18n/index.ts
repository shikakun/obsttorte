import { getLanguage } from "obsidian";
import en from "./en.json";
import ja from "./ja.json";

const catalogs: Record<string, Record<string, string>> = { en, ja };

let language = "en";

export function setLanguage(override: string | null): void {
  const detected = override && override.length > 0 ? override : getLanguage();
  language = catalogs[detected] ? detected : "en";
}

/** 訳が無ければ値をそのまま返す。サーバーが新しい理由を返しても表示が崩れないように */
export function label(prefix: string, value: string): string {
  const key = `${prefix}.${value}`;
  return catalogs[language]?.[key] ?? catalogs.en?.[key] ?? value;
}

type Values = Record<string, string | number>;

export function t(key: string, values?: Values): string {
  const template = catalogs[language]?.[key] ?? catalogs.en?.[key] ?? key;
  if (!values) return template;
  return format(template, values);
}

/** ICU MessageFormatのうち、{name}と{name, plural, one {…} other {…}}だけを扱う */
function format(template: string, values: Values): string {
  let result = "";
  let index = 0;
  while (index < template.length) {
    const open = template.indexOf("{", index);
    const close = open === -1 ? -1 : matchingBrace(template, open);
    if (close === -1) break;
    result += template.slice(index, open) + argument(template.slice(open + 1, close), values);
    index = close + 1;
  }
  return result + template.slice(index);
}

function argument(body: string, values: Values): string {
  if (/^\w+$/.test(body)) return String(values[body] ?? "");
  const match = /^(\w+)\s*,\s*plural\s*,([\s\S]*)$/.exec(body);
  if (!match?.[1] || match[2] === undefined) return `{${body}}`;
  const value = Number(values[match[1]] ?? 0);
  const branches = pluralBranches(match[2]);
  const chosen =
    branches.get(`=${value}`) ??
    branches.get(new Intl.PluralRules(language).select(value)) ??
    branches.get("other") ??
    "";
  return format(chosen.replaceAll("#", String(value)), values);
}

function pluralBranches(source: string): Map<string, string> {
  const branches = new Map<string, string>();
  let index = 0;
  while (index < source.length) {
    const open = source.indexOf("{", index);
    const close = open === -1 ? -1 : matchingBrace(source, open);
    if (close === -1) break;
    branches.set(source.slice(index, open).trim(), source.slice(open + 1, close));
    index = close + 1;
  }
  return branches;
}

function matchingBrace(text: string, open: number): number {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === "{") depth += 1;
    else if (text[index] === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

export function formatList(items: string[]): string {
  return new Intl.ListFormat(language, { type: "conjunction" }).format(items);
}

export function formatDateTime(at: number): string {
  return new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short" }).format(at);
}

export function formatRelative(at: number | null): string {
  if (!at) return "—";
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000));
  if (minutes < 1) return t("time.justNow");
  const format = new Intl.RelativeTimeFormat(language, { style: "narrow" });
  if (minutes < 60) return format.format(-minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 48) return format.format(-hours, "hour");
  return format.format(-Math.round(hours / 24), "day");
}

const BYTE_UNITS = ["byte", "kilobyte", "megabyte", "gigabyte", "terabyte"];

export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < BYTE_UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return new Intl.NumberFormat(language, {
    style: "unit",
    unit: BYTE_UNITS[unit],
    // 短い表記では「12 byte」になるので、バイト単位だけ長い表記にする
    unitDisplay: unit === 0 ? "long" : "short",
    maximumFractionDigits: unit === 0 ? 0 : 1,
  }).format(value);
}
