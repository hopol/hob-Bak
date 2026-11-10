import type { Bus } from "./bus.ts";
import { DesktopService } from "./desktop.ts";
import { KnowledgeStore } from "./knowledge.ts";
import { DesktopControl } from "./desktop-control.ts";
import { DesktopEvents } from "./desktop-events.ts";
import { DesktopPublicLock } from "./desktop-public.ts";
import { DelegationManager } from "./delegations.ts";
import type { HobConfig } from "./config.ts";
import { memoryDir } from "./config.ts";
import { ModelCatalog } from "./models.ts";
import type { PiHost } from "./pi.ts";
import type { ProviderService } from "./providers.ts";
import type { RouterManager } from "./router.ts";
import type { JobManager } from "./jobs.ts";
import type { RoutineScheduler } from "./routines.ts";
import type { LegacyModels } from "./settings.ts";
import type { SettingsStore } from "./settings.ts";
import type { Store } from "./store.ts";
import type { PushSender, PushService } from "./push.ts";
import type { UsageService } from "./usage.ts";
import { Bus as BusImpl } from "./bus.ts";
import { JobManager as JobManagerImpl } from "./jobs.ts";
import { PushService as PushServiceImpl } from "./push.ts";
import { ProviderService as ProviderServiceImpl } from "./providers.ts";
import { RouterManager as RouterManagerImpl } from "./router.ts";
import { RoutineScheduler as RoutineSchedulerImpl } from "./routines.ts";
import { SettingsStore as SettingsStoreImpl } from "./settings.ts";
import { Store as StoreImpl } from "./store.ts";
import { UsagePrices as UsagePricesImpl } from "./usage-prices.ts";
import { UsageService as UsageServiceImpl } from "./usage.ts";

/**
 * 进程内的全部服务。构造时先建 store/bus/pi，再把 router / jobs / routines 挂上去
 * （它们互相需要：任务结束要推 Router 事件，Router 工具要开任务，定时要开任务）。
 */
export interface HobRuntime {
  home: string;
  config: HobConfig;
  store: Store;
  bus: Bus;
  knowledge: KnowledgeStore;
  pi: PiHost;
  /** 界面可改的设置（settings.json），每次现读所以改完立即生效 */
  settings: SettingsStore;
  desktop: DesktopService;
  desktopControl: DesktopControl;
  desktopEvents: DesktopEvents;
  desktopPublic: DesktopPublicLock;
  /** 服务商：设置里存不敏感的，Key 存 secrets.json，变动套进引擎 */
  providers: ProviderService;
  /** 引擎注册表里现在能用的模型（设置页、派任务时看） */
  models: ModelCatalog;
  router: RouterManager;
  jobs: JobManager;
  delegations: DelegationManager;
  routines: RoutineScheduler;
  /** Web Push：VAPID 密钥和订阅在 HOB_HOME/push.json，可见性只在内存里 */
  push: PushService;
  /** 消耗：从会话文件统计用量，单价从 models.dev 拉 */
  usage: UsageService;
}

export interface CreateRuntimeOptions {
  home: string;
  config: HobConfig;
  pi: PiHost;
  /** config.json 里还没搬走的模型设置 */
  legacyModels?: LegacyModels;
  /** 测试注入的推送发送器（不碰网络） */
  pushSender?: PushSender;
  /** 测试注入假的服务商接口（拉模型列表用）和价格表接口（价格用） */
  fetchImpl?: typeof fetch;
}

/** 建出全部服务（不包含 HTTP 和定时器启动），测试和 startHob 共用。 */
export function createRuntime(options: CreateRuntimeOptions): HobRuntime {
  // 本地记忆插件在模块加载时就把记忆目录定下来：直接覆盖（启动入口已经指过一次，测试单独建运行时也要对）
  process.env.PI_MEMORY_DIR = memoryDir(options.home);
  const store = new StoreImpl(options.home);
  store.init();
  store.ensurePrimary();
  store.migrateMemories();
  store.migrateAssistantDuties();
  const bus = new BusImpl();
  const settings = new SettingsStoreImpl(options.home, {
    ...(options.legacyModels ? { legacyModels: options.legacyModels } : {}),
  });
  // 思考档只看 Hob 自己的设置（默认规则 + 每个模型的自定义档位），不看引擎注册表里自带的映射
  const models = new ModelCatalog(options.pi, () => settings.settings.models);
  const providers = new ProviderServiceImpl({
    home: options.home,
    settings,
    pi: options.pi,
    catalog: models,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  // 引擎建好、拿到之前把服务商套进去（内置的设 Key、兼容接口注册成 provider）
  options.pi.configure = (runtime) => providers.applyTo(runtime);
  const runtime = {
    home: options.home,
    config: options.config,
    store,
    bus,
    knowledge: new KnowledgeStore(options.home, bus, store, undefined, () => settings.settings.knowledge?.embedding ?? { source: "off" }),
    pi: options.pi,
    settings,
    desktop: new DesktopService(options.home, settings),
    providers,
    models,
  } as HobRuntime;
  runtime.desktopControl = new DesktopControl(runtime);
  runtime.desktopEvents = new DesktopEvents(runtime);
  runtime.desktopPublic = new DesktopPublicLock();
  runtime.router = new RouterManagerImpl(runtime);
  runtime.jobs = new JobManagerImpl(runtime);
  runtime.delegations = new DelegationManager(runtime);
  runtime.routines = new RoutineSchedulerImpl(runtime);
  runtime.push = new PushServiceImpl({
    home: options.home,
    email: () => runtime.settings.settings.push.email,
    ...(options.pushSender ? { sender: options.pushSender } : {}),
  });
  runtime.usage = new UsageServiceImpl({
    home: options.home,
    store,
    settings,
    prices: new UsagePricesImpl({ home: options.home, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) }),
  });
  return runtime;
}
