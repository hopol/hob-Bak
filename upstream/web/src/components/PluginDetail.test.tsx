import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PluginView } from '../../../shared/types.ts';
vi.mock('../store.ts', () => ({ MOCK: false, useApp: () => ({ assistants: [] }) }));
vi.mock('./Plugins.tsx', () => ({}));
import { configGroups, FileField, MoreSettings, ToolPluginLoginRow } from './PluginDetail.tsx';
import { DeviceCodeLoginCard } from './PluginProviders.tsx';
import { pluginOverallStatus } from './plugin-meta.ts';

describe('optional plugin settings', () => {
  it('starts closed when required fields exist and optional fields are empty', () => {
    const result = configGroups({ address: { required: true }, host: { type: 'string' }, secret: { sensitive: true, configured: false } }, {});
    expect(result.required.map(([key]) => key)).toEqual(['address']);
    expect(result.optional).toHaveLength(2);
    expect(renderToStaticMarkup(<MoreSettings initialOpen={result.initialOpen}>fields</MoreSettings>)).toContain('<button type="button" class="disclosure-row" aria-expanded="false"');
  });
  it('opens for saved values, saved secrets, and forms without required fields', () => {
    expect(configGroups({ address: { required: true }, host: { value: 'server.test' } }, {}).initialOpen).toBe(true);
    expect(configGroups({ address: { required: true }, secret: { sensitive: true, configured: true } }, {}).initialOpen).toBe(true);
    expect(configGroups({ host: {} }, {}).initialOpen).toBe(true);
  });
  it('does not provide a more-settings section when all fields are required', () => {
    expect(configGroups({ token: { required: true } }, {}).optional).toHaveLength(0);
  });
});

describe('file config field', () => {
  it('offers a file picker instead of a path box, and says when a file is already saved', () => {
    const empty = renderToStaticMarkup(<FileField configured={false} onChange={() => {}} />);
    expect(empty).toContain('type="file"');
    expect(empty).toContain('选择文件');
    expect(empty).toContain('还没选文件');
    const saved = renderToStaticMarkup(<FileField configured onChange={() => {}} />);
    expect(saved).toContain('重新选择文件');
    expect(saved).toContain('已上传');
  });
});

describe('tool plugin login UI', () => {
  const noop = () => {};

  it('shows 未登录 and 登录 button when signed out, plus verbatim error if present', () => {
    const html = renderToStaticMarkup(
      <ToolPluginLoginRow
        status={{ signedIn: false, error: '上游接口返回 502' }}
        canStart
        canLogout
        onStart={noop}
        onLogout={noop}
      />,
    );
    expect(html).toContain('未登录');
    expect(html).toContain('登录');
    expect(html).toContain('上游接口返回 502');
    expect(html).not.toContain('退出登录');
  });

  it('offers sign-in as an add-on without 未登录 when login is optional', () => {
    const html = renderToStaticMarkup(
      <ToolPluginLoginRow
        status={{ signedIn: false, optional: true, detail: '正在用个人访问令牌（alex）' }}
        canStart
        canLogout
        onStart={noop}
        onLogout={noop}
      />,
    );
    expect(html).toContain('正在用个人访问令牌（alex）');
    expect(html).toContain('登录');
    expect(html).not.toContain('未登录');
    expect(html).not.toContain('退出登录');
  });

  it('shows status.detail with Markdown links and 退出登录 when signed in', () => {
    const html = renderToStaticMarkup(
      <ToolPluginLoginRow
        status={{ signedIn: true, account: 'alex', detail: '已登录 alex · [管理授权](https://codeforge.example/apps)' }}
        canStart
        canLogout
        onStart={noop}
        onLogout={noop}
      />,
    );
    expect(html).toContain('已登录 alex');
    expect(html).toContain('href="https://codeforge.example/apps"');
    expect(html).toContain('管理授权');
    expect(html).toContain('退出登录');
  });

  it('reuses DeviceCodeLoginCard and renders verbatim poll error without rewriting', () => {
    const waiting = renderToStaticMarkup(
      <DeviceCodeLoginCard
        userCode="F7K2-9QMX"
        url="https://codeforge.example/login/device"
        status="waiting"
        verbatimError
        onRestart={noop}
        onCancel={noop}
      />,
    );
    expect(waiting).toContain('F7K2-9QMX');
    expect(waiting).toContain('https://codeforge.example/login/device');
    expect(waiting).toContain('打开网页');
    expect(waiting).toContain('取消');
    expect(waiting.match(/class="hob-icon-btn"/g)?.length).toBe(2);

    const failed = renderToStaticMarkup(
      <DeviceCodeLoginCard
        userCode="F7K2-9QMX"
        url="https://codeforge.example/login/device"
        status="failed"
        error="authorization_declined: user cancelled"
        verbatimError
        onRestart={noop}
        onCancel={noop}
      />,
    );
    expect(failed).toContain('authorization_declined: user cancelled');
    expect(failed).not.toContain('登录失败：');
    expect(failed).toContain('重新发起');
  });

  it('reports 未登录 badge in plugins list when tool plugin login is signed out', () => {
    const base: PluginView = {
      plugin: { id: 'codeforge', version: '1.0.0', source: 'official', enabled: true, tools: {}, config: {} },
      manifest: { name: 'codeforge', displayName: 'CodeForge' },
      config: {},
      missing: [],
      services: [{ pluginId: 'codeforge', name: 'cf', status: 'connected', tools: [] }],
      login: { service: 'cf', roles: ['status', 'start', 'poll', 'logout'], status: { signedIn: false } },
    };
    expect(pluginOverallStatus(base)).toEqual({ tone: 'needs_login', label: '未登录', rank: 1 });

    const signedIn: PluginView = {
      ...base,
      login: { service: 'cf', roles: ['status', 'start', 'poll', 'logout'], status: { signedIn: true, account: 'alex' } },
    };
    expect(pluginOverallStatus(signedIn)).toEqual({ tone: 'connected', label: '已连接', rank: 9 });

    // Sign-in is an add-on when the plugin already works (e.g. a token is filled in)
    const optional: PluginView = {
      ...base,
      login: { service: 'cf', roles: ['status', 'start', 'poll', 'logout'], status: { signedIn: false, optional: true } },
    };
    expect(pluginOverallStatus(optional)).toEqual({ tone: 'connected', label: '已连接', rank: 9 });

    const pendingConfig: PluginView = {
      ...base,
      services: [{ pluginId: 'codeforge', name: 'cf', status: 'pending_config', tools: [] }],
    };
    expect(pluginOverallStatus(pendingConfig)).toEqual({ tone: 'pending_config', label: '待配置', rank: 0 });
  });
});
