import { t } from "../../../shared/i18n.ts";
import type { PluginCatalogView, PluginInstallProgress, ProviderHostStatusView } from "../../../shared/types.ts";
import { Icon } from "../icons.tsx";
import {
  formatBytesMb,
  formatSourceDisplay,
  hasProviderContribution,
  isUnofficialPlugin,
  permissionMeta,
  pluginDetailText,
  pluginPermissions,
  pluginProviderSpecs,
  pluginPublisher,
  pluginReviewedVersion,
  pluginRiskNotice,
  pluginSourceUrl,
} from "./plugin-meta.ts";
import { PluginIcon, pluginDescription, pluginName } from "./Plugins.tsx";

export type CatalogPluginItem = PluginCatalogView["plugins"][number];

export function PluginPreInstallDetail({
  item,
  sourceLabel,
  error,
  busy,
  onBack,
  onInstall,
}: {
  item: CatalogPluginItem;
  sourceLabel: string;
  error?: string;
  busy?: boolean;
  onBack: () => void;
  onInstall: () => void;
}) {
  const name = pluginName(item.manifest, item.id);
  const hasProviders = hasProviderContribution(item.manifest, item.hasProviders);
  const unofficial = isUnofficialPlugin(item.manifest, item.hasProviders);
  const reviewed = pluginReviewedVersion(item.manifest, item.version);
  const publisher = pluginPublisher(item.manifest);
  const sourceUrl = pluginSourceUrl(item.manifest);
  const permissions = pluginPermissions(item.manifest, item.hasProviders);
  const description = pluginDetailText(item.manifest, pluginDescription(item.manifest, item.id));
  const subtitle = unofficial
    ? t("非官方 · 社区维护 · 我们审过的版本 {version}", { version: reviewed })
    : `${sourceLabel} · ${t("版本 {version}", { version: item.version })}`;

  return (
    <div className="plugin-content">
      <button type="button" className="plugin-link plugin-back-link" onClick={onBack}>
        <Icon name="left" size={15} />
        {t("返回插件")}
      </button>
      <div className="plugin-identity">
        <PluginIcon id={item.id} name={name} manifest={item.manifest} source={item.source} />
        <div className="plugin-identity-text">
          <div className="plugin-title">{name}</div>
          <div className="plugin-sub">{subtitle}</div>
        </div>
      </div>
      {description ? <div className="plugin-sub">{description}</div> : null}

      {(unofficial || hasProviders) ? (
        <>
          <section className="plugin-section">
            <h2>{t("来源与审核")}</h2>
            <div className="plugin-list">
              {publisher ? (
                <div className="plugin-kv">
                  <span className="k">{t("维护者")}</span>
                  <span className="v">{publisher}</span>
                </div>
              ) : null}
              {sourceUrl ? (
                <div className="plugin-kv">
                  <span className="k">{t("来源")}</span>
                  <a className="v plugin-source-link" href={sourceUrl} target="_blank" rel="noreferrer">
                    {formatSourceDisplay(sourceUrl)}
                    <Icon name="out" size={13} />
                  </a>
                </div>
              ) : null}
              <div className="plugin-kv">
                <span className="k">{t("已审版本")}</span>
                <span className="v">{t("我们审过的版本 {version}（固定版本，不自动升级）", { version: reviewed })}</span>
              </div>
            </div>
          </section>

          {permissions.length > 0 ? (
            <section className="plugin-section">
              <h2>{t("它能做什么")}</h2>
              <div className="plugin-list">
                {permissions.map((perm) => {
                  const meta = permissionMeta(perm);
                  return (
                    <div className="plugin-cap" key={perm}>
                      <span className="plugin-cap-ic"><Icon name={meta.icon} size={15} /></span>
                      <div className="plugin-cap-main">
                        <div className="plugin-cap-title">{meta.title}</div>
                        {meta.desc ? <div className="plugin-cap-desc">{meta.desc}</div> : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          ) : null}

          <section className="plugin-connection warn plugin-risk-banner">
            <div className="plugin-warn-head">
              <Icon name="alert" size={15} />
              <span>{t("非官方接入风险提示")}</span>
            </div>
            <div className="plugin-connection-detail">{pluginRiskNotice(item.manifest)}</div>
          </section>
        </>
      ) : null}

      {error ? <div className="badline" role="alert">{error}</div> : null}

      <div className="plugin-actions plugin-install-actions">
        <button type="button" className="hob-btn hob-btn-primary" disabled={busy} onClick={onInstall}>
          {busy ? <Icon name="spin" size={14} className="spin" /> : null}
          {hasProviders || unofficial ? t("安装并启用") : t("安装")}
        </button>
        <button type="button" className="hob-btn" disabled={busy} onClick={onBack}>
          {t("取消")}
        </button>
      </div>
    </div>
  );
}

export function PluginInstallView({
  item,
  progress,
  host,
  done,
  error,
  onBack,
  onOpenPlugin,
  onRetry,
}: {
  item: CatalogPluginItem;
  progress?: PluginInstallProgress;
  host?: ProviderHostStatusView;
  done: boolean;
  error?: string;
  onBack: () => void;
  onOpenPlugin: () => void;
  onRetry: () => void;
}) {
  const name = pluginName(item.manifest, item.id);
  const reviewed = pluginReviewedVersion(item.manifest, item.version);
  const specs = pluginProviderSpecs(item.manifest);
  const pkgLabel = specs[0] ? `${specs[0].package}@${specs[0].version}` : `${item.id}@${reviewed}`;
  const bunVersion = host?.bunVersion || "1.4.2";
  const stage = done ? "done" : progress?.stage ?? (host?.bunInstalled ? "installing_package" : "downloading_bun");
  const isError = Boolean(error) || stage === "error";

  const bunState: "waiting" | "active" | "done" =
    stage === "done" || stage === "installing_package" || stage === "verifying_package"
      ? "done"
      : stage === "downloading_bun" || stage === "verifying_bun" || stage === "extracting_bun"
        ? "active"
        : host?.bunInstalled
          ? "done"
          : "waiting";

  const pkgState: "waiting" | "active" | "done" =
    stage === "done"
      ? "done"
      : stage === "installing_package" || stage === "verifying_package"
        ? "active"
        : "waiting";

  const finishState: "waiting" | "active" | "done" = stage === "done" ? "done" : "waiting";

  const percent = typeof progress?.percent === "number"
    ? Math.max(0, Math.min(100, Math.round(progress.percent)))
    : progress?.downloadedBytes && progress?.totalBytes
      ? Math.max(0, Math.min(100, Math.round((progress.downloadedBytes / progress.totalBytes) * 100)))
      : undefined;

  const bunMeta = bunState === "done"
    ? progress?.totalBytes
      ? t("{size} · 已校验", { size: formatBytesMb(progress.totalBytes) })
      : t("已就绪")
    : bunState === "active"
      ? stage === "verifying_bun"
        ? t("校验哈希中…")
        : stage === "extracting_bun"
          ? t("解压中…")
          : progress?.downloadedBytes !== undefined && progress?.totalBytes
            ? `${formatBytesMb(progress.downloadedBytes)} / ${formatBytesMb(progress.totalBytes)}${percent !== undefined ? ` · ${percent}%` : ""}`
            : percent !== undefined
              ? `${percent}%`
              : t("下载中…")
      : t("等待中");

  const pkgMeta = pkgState === "done"
    ? t("{version} · 已校验", { version: reviewed })
    : pkgState === "active"
      ? stage === "verifying_package"
        ? t("校验哈希中…")
        : t("安装中…")
      : t("等待中");

  const stepIcon = (state: "waiting" | "active" | "done") => {
    if (state === "done") return <span className="plugin-step-ic done"><Icon name="check" size={16} /></span>;
    if (state === "active") return <span className="plugin-step-ic active"><Icon name="spin" size={16} className={isError ? undefined : "spin"} /></span>;
    return <span className="plugin-step-ic"><Icon name="ring" size={15} /></span>;
  };

  const errMsg = error || progress?.error;

  return (
    <div className="plugin-content">
      <button type="button" className="plugin-link plugin-back-link" onClick={onBack}>
        <Icon name="left" size={15} />
        {t("返回插件")}
      </button>
      <div className="plugin-identity">
        <PluginIcon id={item.id} name={name} manifest={item.manifest} source={item.source} />
        <div className="plugin-identity-text">
          <div className="plugin-title">{name}</div>
          <div className="plugin-sub">{t("非官方 · 社区维护 · 我们审过的版本 {version}", { version: reviewed })}</div>
        </div>
      </div>
      <div className="plugin-sub">
        {done
          ? pluginDetailText(item.manifest, pluginDescription(item.manifest, item.id))
          : t("正在首次安装带模型的插件，完成后即可登录使用。")}
      </div>

      {done ? (
        <section className="plugin-connection">
          <div className="plugin-connection-top">
            <span className="plugin-state connected"><span className="plugin-state-dot" />{t("安装完成")}</span>
            <span className="plugin-connection-tools">{t("已校验并启用")}</span>
          </div>
        </section>
      ) : null}

      {isError && errMsg ? (
        <section className="plugin-connection bad">
          <div className="plugin-connection-top">
            <span className="plugin-state error"><span className="plugin-state-dot" />{t("安装失败")}</span>
          </div>
          <div className="plugin-connection-detail">{errMsg}</div>
        </section>
      ) : null}

      <section className="plugin-section">
        <h2>{done ? t("安装步骤") : t("安装进度")}</h2>
        <div className="plugin-list">
          <div className="plugin-step">
            {stepIcon(bunState)}
            <div className="plugin-step-body">
              <div className="plugin-step-top">
                <span>{t("下载运行环境（Bun {version}）", { version: bunVersion })}</span>
                <span className="meta">{bunMeta}</span>
              </div>
              {bunState === "active" && percent !== undefined ? (
                <div className="plugin-bar"><i style={{ width: `${percent}%` }} /></div>
              ) : null}
              {!done ? (
                <div className="plugin-step-sub">{t("所有带模型的插件共用同一份运行环境，后续安装不再重复下载。")}</div>
              ) : null}
            </div>
          </div>

          <div className="plugin-step">
            {stepIcon(pkgState)}
            <div className="plugin-step-body">
              <div className="plugin-step-top">
                <span>{t("安装插件包")}</span>
                <span className="meta">{pkgMeta}</span>
              </div>
              {!done ? (
                <div className="plugin-step-sub">{t("{pkg}（校验哈希）", { pkg: pkgLabel })}</div>
              ) : null}
            </div>
          </div>

          <div className="plugin-step">
            {stepIcon(finishState)}
            <div className="plugin-step-body">
              <div className="plugin-step-top">
                <span>{t("完成并启用")}</span>
                <span className="meta">{finishState === "done" ? t("就绪") : t("等待中")}</span>
              </div>
            </div>
          </div>
        </div>
        {done ? (
          <div className="plugin-note">
            {t("接下来登录你的 {name} 账号，模型会自动出现在「设置 → 服务商」和模型列表中。", { name })}
          </div>
        ) : null}
      </section>

      <div className="plugin-actions plugin-install-actions">
        {done ? (
          <>
            <button type="button" className="hob-btn hob-btn-primary" onClick={onOpenPlugin}>
              {t("前往登录")}
            </button>
            <button type="button" className="hob-btn" onClick={onBack}>
              {t("稍后再说")}
            </button>
          </>
        ) : isError ? (
          <>
            <button type="button" className="hob-btn hob-btn-primary" onClick={onRetry}>
              {t("重试")}
            </button>
            <button type="button" className="hob-btn" onClick={onBack}>
              {t("返回插件")}
            </button>
          </>
        ) : (
          <button type="button" className="hob-btn" onClick={onBack}>
            {t("取消安装")}
          </button>
        )}
      </div>
    </div>
  );
}
