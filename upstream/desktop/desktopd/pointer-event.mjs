// noVNC 的扩展鼠标事件在普通 PointerEvent 后多一个按钮字节。
export function pointerEventLength(data, offset) {
  if (data.length < offset + 2) return undefined;
  return data[offset + 1] & 0x80 ? 7 : 6;
}
