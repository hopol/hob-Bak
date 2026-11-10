import type { IconName } from "./icons.tsx";

const extensions: Record<string, IconName> = {};
for (const [icon, names] of Object.entries({
  image: "png jpg jpeg gif webp bmp ico avif",
  table: "csv tsv xls xlsx ods",
  code: "ts tsx js jsx mjs cjs py go sh bash zsh json jsonl yaml yml toml xml css scss java c cpp h rs rb php sql vue svelte",
  doc: "md markdown txt pdf doc docx odt rtf",
  globe: "html htm svg",
  archive: "zip rar 7z tar gz bz2 xz tgz",
} as const)) {
  for (const name of names.split(" ")) extensions[name] = icon as IconName;
}

/** 文件名的扩展名决定图标；不认识的文件使用通用图标。 */
export function fileIcon(path: string): IconName {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? extensions[name.slice(dot + 1).toLowerCase()] ?? "file" : "file";
}
