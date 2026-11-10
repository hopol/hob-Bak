declare module "@novnc/novnc" {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string);
    viewOnly: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    qualityLevel: number;
    compressionLevel: number;
    disconnect(): void;
    sendKey(keysym: number, code: string | null, down: boolean): void;
    clipboardPasteFrom(text: string): void;
  }
}
