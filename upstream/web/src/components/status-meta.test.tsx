import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DELEGATION_STATUS, JOB_STATUS, StatusTag, jobStatusIcon } from "./status-meta.tsx";

describe("任务和转交状态元数据", () => {
  it("覆盖所有任务状态，统一文字、图标和转圈", () => {
    expect(Object.keys(JOB_STATUS).sort()).toEqual(["queued", "running", "waiting", "done", "stuck", "failed", "stopped"].sort());
    for (const [status, meta] of Object.entries(JOB_STATUS)) {
      expect(meta.text, status).toBeTruthy();
      expect(meta.icon, status).toBeTruthy();
      expect(meta.spin, status).toBe(status === "running");
      expect(renderToStaticMarkup(<StatusTag meta={meta} />)).toContain(meta.text);
    }
    expect(JOB_STATUS.waiting.text).toBe("等助手回复");
    expect(JOB_STATUS.stopped.icon).toBe("stop");
    expect(JOB_STATUS.queued.icon).toBe("clock");
    expect(renderToStaticMarkup(jobStatusIcon("queued", 16))).toContain('M12 7.5V12l3 2');
  });

  it("覆盖所有转交状态，并保留各自文字和图标", () => {
    expect(Object.keys(DELEGATION_STATUS).sort()).toEqual(["running", "waiting", "done", "stuck", "interrupted", "returned", "takenOver"].sort());
    for (const [status, meta] of Object.entries(DELEGATION_STATUS)) {
      expect(meta.text, status).toBeTruthy();
      expect(meta.icon, status).toBeTruthy();
      expect(meta.spin, status).toBe(status === "running");
      expect(renderToStaticMarkup(<StatusTag meta={meta} card />)).toContain(meta.text);
    }
    expect(DELEGATION_STATUS.takenOver.icon).toBe("user");
    expect(DELEGATION_STATUS.waiting.text).toBe("等你确认");
  });
});
