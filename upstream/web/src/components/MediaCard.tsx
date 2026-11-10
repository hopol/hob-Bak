import { useEffect, useRef, useState } from "react";
import { fileKind } from "../../../shared/files.ts";
import { fileUrl, openFilePreview } from "../store.ts";
import { samplePeaks } from "../waveform.ts";

let playing: HTMLAudioElement | null = null;

function AudioCard({ path, name, fallback, itemId }: { path: string; name: string; fallback: () => void; itemId?: string }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [peaks, setPeaks] = useState<number[] | null>(null);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [paused, setPaused] = useState(true);
  const [rate, setRate] = useState(1);
  useEffect(() => {
    const controller = new AbortController();
    let context: AudioContext | undefined;
    void (async () => {
      try {
        const response = await fetch(fileUrl(path), { signal: controller.signal });
        if (!response.ok || Number(response.headers.get("content-length")) > 20 * 1024 * 1024) return;
        const reader = response.body?.getReader();
        if (!reader) return;
        const chunks: Uint8Array[] = [];
        let size = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 20 * 1024 * 1024) { await reader.cancel(); return; }
          chunks.push(value);
        }
        const data = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
        context = new AudioContext();
        const decoded = await context.decodeAudioData(data.buffer);
        if (!controller.signal.aborted) setPeaks(samplePeaks(decoded.getChannelData(0), 50));
      } catch { /* 解码失败时保留普通进度条 */ }
      finally { if (context) void context.close(); }
    })();
    return () => { controller.abort(); if (playing === audio.current) playing = null; };
  }, [path]);
  const progress = duration ? Math.min(1, time / duration) : 0;
  const clock = (n: number) => `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, "0")}`;
  return <div className="media-audio" data-item-id={itemId}>
    <audio ref={audio} src={fileUrl(path)} preload="metadata" onError={fallback}
      onPlay={(event) => { if (playing && playing !== event.currentTarget) playing.pause(); playing = event.currentTarget; setPaused(false); }}
      onPause={() => setPaused(true)} onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
      onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)} />
    <button className="audio-play" aria-label={paused ? "播放" : "暂停"} onClick={() => { const el = audio.current; if (!el) return; if (el.paused) void el.play().catch(fallback); else el.pause(); }}>
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="currentColor">{paused ? <path d="M8.5 5.8v12.4a1 1 0 0 0 1.5.86l10-6.2a1 1 0 0 0 0-1.72l-10-6.2a1 1 0 0 0-1.5.86Z" /> : <path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" />}</svg>
    </button>
    <div className="audio-main">
      <button className="audio-name" onClick={() => openFilePreview(path, name)}>{name}</button>
      <div className="audio-track">
        {peaks ? <div className="audio-bars" aria-hidden="true">{peaks.map((v, i) => <i key={i} className={i / peaks.length < progress ? "played" : ""} style={{ height: `${Math.max(12, v * 100)}%` }} />)}</div> : <div className="audio-line"><i style={{ width: `${progress * 100}%` }} /></div>}
        <input type="range" aria-label="播放进度" min={0} max={duration || 0} step="0.01" value={Math.min(time, duration || 0)} onChange={(event) => { if (audio.current) audio.current.currentTime = Number(event.target.value); }} />
      </div>
    </div>
    <span className="audio-time">{clock(duration || 0)}</span>
    <button className="audio-rate" onClick={() => { const next = rate === 1 ? 1.5 : rate === 1.5 ? 2 : 1; setRate(next); if (audio.current) audio.current.playbackRate = next; }}>{rate}×</button>
  </div>;
}

export function MediaCard({ path, name, fallback, itemId }: { path: string; name: string; fallback: React.ReactNode; itemId?: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return fallback;
  const kind = fileKind(path);
  if (kind === "audio") return <AudioCard path={path} name={name} fallback={() => setFailed(true)} itemId={itemId} />;
  if (kind === "video") return <div className="media-video" data-item-id={itemId}><video controls playsInline preload="metadata" src={fileUrl(path)} onError={() => setFailed(true)} /><button onClick={() => openFilePreview(path, name)}>{name}</button></div>;
  return fallback;
}
