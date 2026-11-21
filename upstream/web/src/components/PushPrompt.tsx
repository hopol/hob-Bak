import { useEffect, useState } from "react";
import { t } from "../../../shared/i18n.ts";
import { canShowPushPrompt, currentSubscription, PUSH_PROMPT_DISMISSED, pushSupported } from "../push.ts";
import { connectPush } from "../store.ts";

export function PushPrompt() {
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!pushSupported()) return;
    const dismissed = localStorage.getItem(PUSH_PROMPT_DISMISSED) === "1";
    if (dismissed || Notification.permission === "denied") return;
    let active = true;
    void currentSubscription().then((subscription) => {
      if (!active) return;
      setVisible(canShowPushPrompt({
        supported: true,
        subscribed: Boolean(subscription),
        permission: Notification.permission,
        dismissed,
      }));
    }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  if (!visible) return null;

  const enable = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await connectPush();
      if (result.ok) {
        setVisible(false);
        return;
      }
      setError(result.error);
    } finally {
      setBusy(false);
    }
  };

  const dismiss = () => {
    localStorage.setItem(PUSH_PROMPT_DISMISSED, "1");
    setVisible(false);
  };

  return (
    <div className="push-prompt" role="status">
      <div className="push-prompt-main">{t("打开通知：助手需要你回答或已完成时，这台设备会收到提醒")}</div>
      <div className="push-prompt-actions">
        <button className="hob-btn hob-btn-primary" onClick={() => void enable()} disabled={busy}>
          {busy ? t("正在打开…") : t("打开")}
        </button>
        <button className="hob-btn" onClick={dismiss} disabled={busy}>{t("暂不开启")}</button>
      </div>
      {error ? <div className="push-prompt-error">{error}</div> : null}
    </div>
  );
}
