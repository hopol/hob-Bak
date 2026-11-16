// 登录页：GET /api/me 401 时显示。
import { useEffect, useState } from "react";
import { localeName, t } from "../../../shared/i18n.ts";
import { Avatar } from "../sprites.tsx";
import { login, setLocale, useApp } from "../store.ts";

export function Login() {
  const s = useApp();
  const [pw, setPw] = useState("");
  const [shake, setShake] = useState(false);

  // 密码不对：输入框抖一下（240ms，三下）
  useEffect(() => {
    if (!s.error) return;
    setShake(true);
    const t = window.setTimeout(() => setShake(false), 260);
    return () => window.clearTimeout(t);
  }, [s.error]);

  const go = () => {
    if (pw) void login(pw);
  };
  return (
    <div className="login">
      <div className="card">
        <Avatar sprite="hob" size={88} free motion="home" />
        <div className="nm">Hob</div>
        <div className="ds">{t("请输入密码")}</div>
        <label className={`field${shake ? " shake" : ""}`}>
          <input
            type="password"
            autoFocus
            value={pw}
            placeholder={t("密码")}
            onChange={(e) => setPw(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") go();
            }}
          />
        </label>
        <button className="hob-btn hob-btn-primary" onClick={go} disabled={s.loggingIn}>
          {s.loggingIn ? t("正在登录…") : t("登录")}
        </button>
        <button className="lang" type="button" onClick={() => setLocale(s.locale === "en" ? "zh-CN" : "en", false)}>
          {s.locale === "en" ? "中文" : "English"}
        </button>
        {s.error ? (
          <div className="err" style={{ width: "100%" }}>
            {s.error}
          </div>
        ) : null}
      </div>
    </div>
  );
}
