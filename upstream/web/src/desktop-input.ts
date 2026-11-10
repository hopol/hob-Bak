export function characterKeysym(character: string): number {
  const codepoint = character.codePointAt(0)!;
  return codepoint <= 0xff ? codepoint : 0x01000000 + codepoint;
}

export function compositionInput(committed: string, text: string): string {
  return committed && committed === text ? "" : text;
}

export function textInputMethod(text: string): "keys" | "paste" {
  return /[\r\n]/.test(text) || Array.from(text).length > 32 ? "paste" : "keys";
}

export function isPasteShortcut(event: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey">): boolean {
  return (event.code === "KeyV" || (!event.code && event.key.toLowerCase() === "v")) && (event.ctrlKey || event.metaKey) && !event.altKey;
}

const specialKeys: Record<string, number> = {
  Backspace: 0xff08, Tab: 0xff09, Enter: 0xff0d, Escape: 0xff1b,
  Home: 0xff50, ArrowLeft: 0xff51, ArrowUp: 0xff52, ArrowRight: 0xff53, ArrowDown: 0xff54,
  PageUp: 0xff55, PageDown: 0xff56, End: 0xff57, Insert: 0xff63, Delete: 0xffff,
  Shift: 0xffe1, Control: 0xffe3, Meta: 0xffeb, Alt: 0xffe9, CapsLock: 0xffe5,
};

/** mac：本机 ⌘ 当远端 Ctrl 发，⌘C / ⌘A 等在云桌面里照常生效 */
export function keyboardKeysym(event: Pick<KeyboardEvent, "key" | "location"> & Partial<Pick<KeyboardEvent, "code" | "ctrlKey" | "metaKey">>, mac = false): number | null {
  if (event.key in specialKeys) {
    const symbol = specialKeys[mac && event.key === "Meta" ? "Control" : event.key];
    return event.location === 2 && ["Shift", "Control", "Meta", "Alt"].includes(event.key) ? symbol + 1 : symbol;
  }
  if ((event.ctrlKey || event.metaKey) && /^Key[A-Z]$/.test(event.code ?? "")) {
    return event.code!.charCodeAt(3) + 32;
  }
  const functionKey = /^F([1-9]|1[0-2])$/.exec(event.key);
  if (functionKey) return 0xffbd + Number(functionKey[1]);
  return Array.from(event.key).length === 1 ? characterKeysym(event.key) : null;
}
