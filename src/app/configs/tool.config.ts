import { IMenuItem } from "./menu.config";

export interface AppItem extends IMenuItem {
  id: string;
  description?: string;
  enabled?: boolean;
  core?: string[];
  lock?: boolean;
}

export interface ChildToolAppConfig extends Partial<AppItem> {
  available?: boolean;
  defaultToolbar?: boolean;
}

export interface ChildToolConfig {
  id: string;
  titleKey: string;
  namespace: string;
  app?: ChildToolAppConfig;
  childDir?: string;
  entry?: string;
  uiIndex?: string;
  routePath?: string;
  requiredDependencies?: string[];
  installHint?: string;
  startupTimeoutMs?: number;
  env?: Record<string, string>;
}

let childToolConfigsLoaded = false;
let childToolConfigLoadError: Error | null = null;

export let CHILD_TOOL_CONFIGS: Record<string, ChildToolConfig> = {};

export function getChildToolConfigs(forceReload = false): Record<string, ChildToolConfig> {
  if (!childToolConfigsLoaded || forceReload) {
    try {
      CHILD_TOOL_CONFIGS = loadChildToolConfigs();
      childToolConfigLoadError = null;
    } catch (error) {
      childToolConfigLoadError = error instanceof Error ? error : new Error(String(error || 'Unknown error'));
      CHILD_TOOL_CONFIGS = {};
      console.error('[child-tools] Failed to load child tools index:', childToolConfigLoadError);
    }
    childToolConfigsLoaded = true;
  }

  return CHILD_TOOL_CONFIGS;
}

export function getChildToolConfigLoadError(): Error | null {
  return childToolConfigLoadError;
}

export function getChildToolConfig(toolId: string): ChildToolConfig | null {
  return getChildToolConfigs()[toolId] || null;
}

export function isChildTool(toolId: string): boolean {
  return !!getChildToolConfig(toolId);
}

export function getChildToolAppItems(): AppItem[] {
  return Object.values(getChildToolConfigs())
    .filter(config => config.app?.available !== false)
    .map(config => createChildToolAppItem(config));
}

export function getChildToolAvailableAppIds(): string[] {
  return getChildToolAppItems().map(app => app.id);
}

export function getChildToolDefaultToolbarAppIds(): string[] {
  return Object.values(getChildToolConfigs())
    .filter(config => config.app?.available !== false && config.app?.defaultToolbar === true)
    .map(config => config.app?.id || config.id);
}

function loadChildToolConfigs(): Record<string, ChildToolConfig> {
  const raw = readChildToolIndexText();
  if (!raw) {
    return {};
  }

  return normalizeChildToolConfigs(JSON.parse(raw));
}

function readChildToolIndexText(): string | null {
  const fsApi = typeof window !== 'undefined' ? window['fs'] : null;
  const pathApi = typeof window !== 'undefined' ? window['path'] : null;
  const childPath = pathApi?.getAilyChildPath?.();

  if (childPath && pathApi?.join && fsApi?.existsSync && fsApi?.readFileSync) {
    const indexPath = pathApi.join(childPath, 'tools', 'index.json');
    if (fsApi.existsSync(indexPath)) {
      return fsApi.readFileSync(indexPath, 'utf8');
    }

    throw new Error(`Child tools index was not found: ${indexPath}`);
  }

  return null;
}

function normalizeChildToolConfigs(indexData: any): Record<string, ChildToolConfig> {
  const source = indexData?.tools || indexData;

  if (Array.isArray(source)) {
    return source.reduce((configs: Record<string, ChildToolConfig>, item: any) => {
      if (item?.id) {
        configs[item.id] = item as ChildToolConfig;
      }
      return configs;
    }, {});
  }

  if (!source || typeof source !== 'object') {
    throw new Error('Child tools index must be an object or a tools array');
  }

  return Object.entries(source).reduce((configs: Record<string, ChildToolConfig>, [toolId, value]) => {
    if (value && typeof value === 'object') {
      const config = value as ChildToolConfig;
      configs[config.id || toolId] = {
        ...config,
        id: config.id || toolId
      };
    }
    return configs;
  }, {});
}

function createChildToolAppItem(config: ChildToolConfig): AppItem {
  const app = config.app || {};
  const appId = app.id || config.id;

  return {
    ...app,
    id: appId,
    name: config.titleKey,
    description: `${config.namespace}.DESCRIPTION`,
    action: app.action || 'tool-open',
    data: app.data || { type: 'tool', data: config.id },
    icon: app.icon || 'fa-light fa-puzzle-piece',
    enabled: app.enabled !== false
  };
}

// 默认的 App 注册表，展示位置由 AppStoreService 管理
export const APP_LIST: AppItem[] = [
  {
    id: 'code-viewer',
    name: 'MENU.CODE',
    description: 'APP_STORE.CODE_DESC',
    action: 'tool-open',
    data: { type: 'tool', data: 'code-viewer' },
    icon: 'fa-light fa-rectangle-code',
    router: ['/main/blockly-editor'],
    enabled: true
  },
  {
    id: 'lib-manager',
    name: 'MENU.LIB_MANAGER',
    description: 'APP_STORE.LIB_MANAGER_DESC',
    action: 'tool-open',
    data: { type: 'tool', data: 'lib-manager' },
    icon: 'fa-light fa-books',
    router: ['/main/code-editor'],
    enabled: true
  },
  {
    id: 'serial-monitor',
    name: 'MENU.TOOL_SERIAL',
    description: 'APP_STORE.SERIAL_DESC',
    action: 'tool-open',
    data: { type: 'tool', data: 'serial-monitor' },
    icon: 'fa-light fa-monitor-waveform',
    enabled: true,
    lock: true
  },
  {
    id: 'ffs-manager',
    name: 'MENU.FFS_MANAGER',
    description: 'APP_STORE.FFS_MANAGER_DESC',
    action: 'tool-open',
    data: { type: 'tool', data: 'ffs-manager' },
    icon: 'fa-light fa-database',
    enabled: true,
    // router: ['/main/blockly-editor'],
    // core: ['esp32'] // 仅 esp32 核心可用
  },
  {
    id: 'aily-chat',
    name: 'MENU.AI',
    description: 'APP_STORE.AI_DESC',
    action: 'tool-open',
    data: { type: 'tool', data: 'aily-chat' },
    icon: 'fa-light fa-star-christmas',
    more: 'AI',
    enabled: true,
    lock: true
  },
  {
    id: 'model-store',
    name: 'MENU.MODEL_STORE',
    description: 'APP_STORE.MODEL_STORE_DESC',
    action: 'tool-open',
    data: { type: 'tool', data: 'model-store' },
    icon: 'fa-light fa-microchip-ai',
    enabled: true
  },
  {
    id: 'cloud-space',
    name: 'MENU.USER_SPACE',
    description: 'APP_STORE.CLOUD_SPACE_DESC',
    action: 'tool-open',
    data: { type: 'tool', data: 'cloud-space' },
    icon: 'fa-light fa-album-collection',
    enabled: true
  },
  {
    id: 'user-center',
    name: 'MENU.USER_AUTH',
    description: 'APP_STORE.USER_CENTER_DESC',
    action: 'tool-open',
    data: { type: 'tool', data: 'user-center' },
    icon: 'fa-light fa-user',
    enabled: true,
    lock: true
  },
  {
    id: 'simulator',
    name: 'MENU.SIMULATOR',
    description: 'APP_STORE.SIMULATOR_DESC',
    action: 'tool-open',
    data: { type: 'tool', data: 'simulator' },
    icon: 'fa-light fa-atom',
    router: ['/main/blockly-editor'],
    dev: true,
    enabled: false
  }
];

// 所有可用的 App id。App Store 和 toolbar 只会使用这里列出的 App。
export const AVAILABLE_APP_IDS: string[] = [
  'code-viewer',
  'serial-monitor',
  'ffs-manager',
  'aily-chat',
  'model-store',
  'cloud-space',
  'user-center',
];

// 软件初始状态 toolbar 显示的 App id。用户调整后会保存到本地配置。
export const DEFAULT_TOOLBAR_APP_IDS: string[] = [
  'code-viewer',
  'serial-monitor',
  'aily-chat',
  'cloud-space',
  // 'model-store'
];
