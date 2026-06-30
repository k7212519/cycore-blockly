// 模块级缓存变量，用于存储当前的 Registry/工具站地址
import { environment } from '../../environments/environment';

let _cachedRegistryUrl: string | null = null;
let _cachedToolWebUrl: string | null = null;

export function getApiBaseUrl(): string {
  const edaApiBaseUrl = (window as any).__EDA_API_BASE_URL__;
  return edaApiBaseUrl ? String(edaApiBaseUrl).replace(/\/$/, '') : environment.apiBaseUrl;
}

function getInitialToolWebUrl(): string {
  return 'https://tool.aily.pro';
}

function getInitialRegistryUrl(): string {
  return 'https://registry.diandeng.tech';
}

function getRegistryUrl(): string {
  if (_cachedRegistryUrl !== null) {
    return _cachedRegistryUrl;
  }
  return getInitialRegistryUrl();
}

export function getToolWebUrl(): string {
  if (_cachedToolWebUrl !== null) {
    return _cachedToolWebUrl;
  }
  return getInitialToolWebUrl();
}

/**
 * 更新 NPM Registry 地址（在设置页面更改后调用）
 * @param url 新的 Registry 地址
 */
export function setRegistryUrl(url: string): void {
  _cachedRegistryUrl = url;
}

export function setToolWebUrl(url: string): void {
  _cachedToolWebUrl = url;
}

// 使用 getter 动态获取 API 地址，确保每次访问都读取最新的环境变量
export const API = {
  get registryBase() { return getRegistryUrl(); },
  get projectList() { return `${getRegistryUrl()}/-/verdaccio/data/packages`; },
  get projectSearch() { return `${getRegistryUrl()}/-/v1/search`; },
  // ai
  get startSession() { return `${getApiBaseUrl()}/api/v1/start_session`; },
  get closeSession() { return `${getApiBaseUrl()}/api/v1/close_session`; },
  get streamConnect() { return `${getApiBaseUrl()}/api/v1/stream`; },
  get sendMessage() { return `${getApiBaseUrl()}/api/v1/send_message`; },
  /** 无状态聊天请求：每次请求携带完整 messages[]，返回 SSE 流 */
  get chatRequest() { return `${getApiBaseUrl()}/api/v1/chat`; },
  get getHistory() { return `${getApiBaseUrl()}/api/v1/conversation_history`; },
  get stopSession() { return `${getApiBaseUrl()}/api/v1/stop_session`; },
  get cancelTask() { return `${getApiBaseUrl()}/api/v1/cancel_task`; },
  get generateTitle() { return `${getApiBaseUrl()}/api/v1/generate_title`; },
  // cloud
  get cloudBase() { return `${getApiBaseUrl()}/api/v1/cloud`; },
  get cloudSync() { return `${getApiBaseUrl()}/api/v1/cloud/sync`; },
  get cloudProjects() { return `${getApiBaseUrl()}/api/v1/cloud/projects`; },
  get cloudPublicProjects() { return `${getApiBaseUrl()}/api/v1/cloud/projects/public`; },
  // server-side local projects
  get serverProjects() { return `${getApiBaseUrl()}/api/projects`; },
  get serverProjectBoards() { return `${getApiBaseUrl()}/api/projects/boards`; },
  get serverProjectLibraries() { return `${getApiBaseUrl()}/api/projects/libraries`; },
  // feedback
  get feedback() { return `${getApiBaseUrl()}/api/v1/feedback/submit`; },
  get feedbackImageUpload() { return `${getApiBaseUrl()}/api/v1/feedback/upload-image`; },
  // model list
  get modelList() { return `${getApiBaseUrl()}/api/v1/model/list`; },
  // model details
  get modelDetails() { return `${getApiBaseUrl()}/api/v1/model`; },
  // firmware info
  get firmwareInfo() { return `${getApiBaseUrl()}/api/v1/firmware/info`; },
  get downloadFirmware() { return `${getApiBaseUrl()}/api/v1/firmware/download`; },
};
