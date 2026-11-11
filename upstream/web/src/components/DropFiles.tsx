// 拖文件进浏览器：整页浮一层「松开即可上传」，松手就把文件加进输入框。
// 监听挂在 window 上：拖到哪里松手都算，顺便挡住浏览器「把文件当成要打开的页面」的默认动作。
import { useEffect, useRef, useState } from "react";
import { droppedFiles, isFileDrag } from "../dropped-files.ts";
import { attach, useApp } from "../store.ts";

/** 这么久没有任何拖动事件就当已经拖出去了：拖到窗口外松手时有些浏览器只补 dragleave，不补 drop，计数会停在半路。 */
const IDLE = 1500;

export function DropFiles() {
  const s = useApp();
  const a = s.assistants.find((x) => x.id === s.sel);
  const [over, setOver] = useState(false);
  // dragenter / dragleave 在每个子元素上都会各来一次，计数归零才算真的离开窗口
  const depth = useRef(0);
  const idle = useRef(0);

  useEffect(() => {
    const wake = () => {
      setOver(true);
      clearTimeout(idle.current);
      idle.current = window.setTimeout(() => {
        depth.current = 0;
        setOver(false);
      }, IDLE);
    };
    const onEnter = (event: DragEvent) => {
      if (!isFileDrag(event.dataTransfer)) return;
      depth.current += 1;
      wake();
    };
    const onLeave = (event: DragEvent) => {
      if (!isFileDrag(event.dataTransfer)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current) return;
      clearTimeout(idle.current);
      setOver(false);
    };
    // 不拦 dragover，浏览器会把窗口当成「打开这个文件」的目标，松手整页就换成文件内容了
    const onOver = (event: DragEvent) => {
      if (!isFileDrag(event.dataTransfer)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      wake();
    };
    const onDrop = (event: DragEvent) => {
      if (!isFileDrag(event.dataTransfer)) return;
      event.preventDefault();
      depth.current = 0;
      clearTimeout(idle.current);
      setOver(false);
      const files = droppedFiles(event.dataTransfer);
      if (files.length) attach(files);
    };
    // 捕获阶段：对话里谁先拦了拖动都不影响这里接住文件
    const opts = { capture: true } as const;
    window.addEventListener("dragenter", onEnter, opts);
    window.addEventListener("dragleave", onLeave, opts);
    window.addEventListener("dragover", onOver, opts);
    window.addEventListener("drop", onDrop, opts);
    return () => {
      clearTimeout(idle.current);
      window.removeEventListener("dragenter", onEnter, opts);
      window.removeEventListener("dragleave", onLeave, opts);
      window.removeEventListener("dragover", onOver, opts);
      window.removeEventListener("drop", onDrop, opts);
    };
  }, []);

  if (!over) return null;
  return (
    <div className="dropmask" role="status">
      <div className="dropcard">
        <div className="t">松开即可上传</div>
        <div className="d">{a ? `文件会加进和 ${a.name} 的输入框，发送时一起发出去` : "文件会加进输入框，发送时一起发出去"}</div>
      </div>
    </div>
  );
}
