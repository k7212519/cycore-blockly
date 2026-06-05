import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { TranslateService } from '@ngx-translate/core';
import { lastValueFrom } from 'rxjs';

export const TOOL_I18N_NAMESPACES = {
  'aily-chat': ['AILY_CHAT'],
  'app-store': ['APP_STORE'],
  'ble-debugger': ['BLE_DEBUGGER'],
  'ffs-manager': ['FFS_MANAGER'],
  'industrial-bus-debugger': ['INDUSTRIAL_BUS_DEBUGGER'],
  'log': ['LOG'],
  'model-store': ['MODEL_STORE'],
  'mqtt-debugger': ['MQTT_DEBUGGER'],
  'network-debugger': ['NETWORK_DEBUGGER'],
  'serial-monitor': ['SERIAL'],
  'user-center': ['USER_CENTER'],
} as const;

export type ToolI18nName = keyof typeof TOOL_I18N_NAMESPACES;

@Injectable({
  providedIn: 'root',
})
export class ToolI18nService {
  private loaded = new Set<string>();
  private registeredTools = new Set<ToolI18nName>();
  private inFlight = new Map<string, Promise<void>>();

  constructor(
    private http: HttpClient,
    private translate: TranslateService,
  ) {
    this.translate.onLangChange.subscribe((event) => {
      for (const tool of this.registeredTools) {
        void this.load(tool, event.lang, true);
      }
    });
  }

  load(toolName: string, lang: string = this.currentLang(), force = false): Promise<void> {
    if (!this.isToolI18nName(toolName)) {
      return Promise.resolve();
    }

    this.registeredTools.add(toolName);
    const key = `${lang}:${toolName}`;

    if (!force && this.loaded.has(key)) {
      return Promise.resolve();
    }

    const currentRequest = this.inFlight.get(key);
    if (currentRequest) {
      return currentRequest;
    }

    const request = lastValueFrom(
      this.http.get<Record<string, unknown>>(`tools/${toolName}/i18n/${lang}.json`, {
        responseType: 'json',
      }),
    )
      .then((data) => {
        this.translate.setTranslation(lang, data, true);
        this.loaded.add(key);
      })
      .catch((error) => {
        console.warn(`Failed to load i18n for tool ${toolName} (${lang}):`, error);
      })
      .finally(() => {
        this.inFlight.delete(key);
      });

    this.inFlight.set(key, request);
    return request;
  }

  private currentLang(): string {
    return this.translate.currentLang || this.translate.defaultLang || 'en';
  }

  private isToolI18nName(toolName: string): toolName is ToolI18nName {
    return Object.prototype.hasOwnProperty.call(TOOL_I18N_NAMESPACES, toolName);
  }
}
