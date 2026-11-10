import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../desktopd/server.mjs", import.meta.url), "utf8");
const code = source.slice(source.indexOf("const ENC_EXTENDED_DESKTOP_SIZE"), source.indexOf("function pipeVnc("));
const context = vm.createContext({ Buffer });
vm.runInContext(code, context);

for (const [version, init] of [["003.008", [1, 1]], ["003.003", [1]]]) {
  test(`RFB ${version} 分包、剪贴板和重复编码协商`, () => {
    const handshake = Buffer.concat([Buffer.from(`RFB ${version}\n`), Buffer.from(init)]);
    const clipboard = Buffer.from([6, 0, 0, 0, 0, 0, 0, 3, 97, 98, 99]);
    const extendedClipboard = Buffer.alloc(12);
    extendedClipboard[0] = 6;
    extendedClipboard.writeInt32BE(-4, 4);
    const encodings = Buffer.alloc(12);
    encodings[0] = 2;
    encodings.writeUInt16BE(2, 2);
    encodings.writeInt32BE(-308, 4);
    encodings.writeInt32BE(7, 8);
    const bytes = Buffer.concat([handshake, clipboard, extendedClipboard, encodings]);
    const filter = context.createSetEncodingsFilter();
    const pieces = [];
    for (const byte of bytes) pieces.push(...filter(Buffer.from([byte])));
    const expected = Buffer.alloc(8);
    expected[0] = 2;
    expected.writeUInt16BE(1, 2);
    expected.writeInt32BE(7, 4);
    assert.deepEqual(Buffer.concat(pieces), Buffer.concat([handshake, clipboard, extendedClipboard, expected]));
  });
}
