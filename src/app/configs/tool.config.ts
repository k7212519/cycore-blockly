import { IMenuItem } from "./menu.config";

export interface AppItem extends IMenuItem {
  id: string;
  description?: string;
  enabled?: boolean;
  core?: string[];
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
    enabled: true
  },
  {
    id: 'mqtt-debugger',
    name: 'MENU.MQTT_DEBUGGER',
    description: 'APP_STORE.MQTT_DEBUGGER_DESC',
    action: 'tool-open',
    data: { type: 'tool', data: 'mqtt-debugger' },
    icon: 'fa-light fa-tower-broadcast',
    enabled: true
  },
  {
    id: 'network-debugger',
    name: 'MENU.NETWORK_DEBUGGER',
    description: 'APP_STORE.NETWORK_DEBUGGER_DESC',
    action: 'tool-open',
    data: { type: 'tool', data: 'network-debugger' },
    icon: 'fa-light fa-network-wired',
    enabled: true
  },
  {
    id: 'industrial-bus-debugger',
    name: 'MENU.INDUSTRIAL_BUS_DEBUGGER',
    description: 'APP_STORE.INDUSTRIAL_BUS_DEBUGGER_DESC',
    action: 'tool-open',
    data: { type: 'tool', data: 'industrial-bus-debugger' },
    icon: 'fa-light fa-microchip',
    enabled: true
  },
  {
    id: 'ffs-manager',
    name: 'MENU.FFS_MANAGER',
    description: 'APP_STORE.FFS_MANAGER_DESC',
    action: 'tool-open',
    data: { type: 'tool', data: 'ffs-manager' },
    icon: 'fa-light fa-database',
    enabled: true,
    router: ['/main/blockly-editor'],
    core: ['esp32'] // 仅 esp32 核心可用
  },
  {
    id: 'aily-chat',
    name: 'MENU.AI',
    description: 'APP_STORE.AI_DESC',
    action: 'tool-open',
    data: { type: 'tool', data: 'aily-chat' },
    icon: 'fa-light fa-star-christmas',
    more: 'AI',
    enabled: true
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
    enabled: true
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
  // 'mqtt-debugger',
  // 'network-debugger',
  // 'industrial-bus-debugger',
  'ffs-manager',
  'aily-chat',
  'model-store',
  'cloud-space',
  'user-center',
  'ffs-manager'
];

// 软件初始状态 toolbar 显示的 App id。用户调整后会保存到本地配置。
export const DEFAULT_TOOLBAR_APP_IDS: string[] = [
  'code-viewer',
  'serial-monitor',
  'aily-chat',
  'cloud-space',
  // 'model-store'
];
