import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import {
  APP_LIST,
  APP_STORE_STORAGE_KEY,
  APP_STORE_ZONES,
  AVAILABLE_APP_IDS,
  AppItem,
  AppPlacementZone,
  AppStoreLayout,
  DEFAULT_APP_STORE_LAYOUT,
  HEADER_APP_LIMIT
} from './app-store.config';

export interface AppVisibilityContext {
  routeUrl?: string;
  boardCore?: string;
  isDevMode?: boolean;
}

@Injectable({
  providedIn: 'root'
})
export class AppStoreService {
  private readonly appMap = new Map(
    APP_LIST
      .filter(app => AVAILABLE_APP_IDS.includes(app.id))
      .map(app => [app.id, app])
  );
  private readonly zoneLimits = new Map(APP_STORE_ZONES.map(zone => [zone.id, zone.limit]));
  private readonly layoutSubject = new BehaviorSubject<AppStoreLayout>(this.loadLayout());

  readonly layout$ = this.layoutSubject.asObservable();
  readonly HEADER_APP_LIMIT = HEADER_APP_LIMIT;

  get layout(): AppStoreLayout {
    return this.cloneLayout(this.layoutSubject.value);
  }

  getAllApps(): AppItem[] {
    return [...this.appMap.values()].map(app => ({ ...app }));
  }

  getEnabledApps(): AppItem[] {
    return this.getAllApps().filter(app => app.enabled !== false);
  }

  getApp(appId: string): AppItem | undefined {
    const app = this.appMap.get(appId);
    return app ? { ...app } : undefined;
  }

  getAppsForZone(zone: AppPlacementZone): AppItem[] {
    return this.layoutSubject.value.zones[zone]
      .map(appId => this.appMap.get(appId))
      .filter((app): app is AppItem => !!app && app.enabled !== false)
      .map(app => ({ ...app }));
  }

  getZoneIds(zone: AppPlacementZone): string[] {
    return [...this.layoutSubject.value.zones[zone]];
  }

  setZoneApps(zone: AppPlacementZone, appIds: string[]): void {
    const nextLayout = this.cloneLayout(this.layoutSubject.value);
    nextLayout.zones[zone] = this.sanitizeZoneIds(zone, appIds);
    this.commitLayout(nextLayout);
  }

  setVisibleZoneOrder(zone: AppPlacementZone, visibleIds: string[], visibleCatalogIds: string[]): void {
    const visibleCatalogIdSet = new Set(visibleCatalogIds);
    const preservedHiddenIds = this.layoutSubject.value.zones[zone]
      .filter(appId => !visibleCatalogIdSet.has(appId));

    this.setZoneApps(zone, [...visibleIds, ...preservedHiddenIds]);
  }

  toggleAppInZone(zone: AppPlacementZone, appId: string): void {
    if (this.isAppInZone(zone, appId)) {
      this.removeAppFromZone(zone, appId);
    } else {
      this.addAppToZone(zone, appId);
    }
  }

  addAppToZone(zone: AppPlacementZone, appId: string): boolean {
    if (!this.canRegisterApp(appId) || this.isAppInZone(zone, appId)) {
      return false;
    }

    const ids = this.getZoneIds(zone);
    const limit = this.getZoneLimit(zone);
    if (ids.length >= limit) {
      return false;
    }

    this.setZoneApps(zone, [...ids, appId]);
    return true;
  }

  removeAppFromZone(zone: AppPlacementZone, appId: string): void {
    this.setZoneApps(zone, this.getZoneIds(zone).filter(id => id !== appId));
  }

  isAppInZone(zone: AppPlacementZone, appId: string): boolean {
    return this.layoutSubject.value.zones[zone].includes(appId);
  }

  getZoneLimit(zone: AppPlacementZone): number {
    return this.zoneLimits.get(zone) || Number.MAX_SAFE_INTEGER;
  }

  isAppVisible(app: AppItem, context: AppVisibilityContext = {}): boolean {
    if (app.enabled === false) {
      return false;
    }

    if (app.dev && !context.isDevMode) {
      return false;
    }

    if (app.router?.length && context.routeUrl) {
      const inRoute = app.router.some(route => context.routeUrl?.includes(route));
      if (!inRoute) {
        return false;
      }
    }

    if (app.core?.length) {
      const currentCore = String(context.boardCore || '').toLowerCase();
      return app.core.some(core => this.matchesAppCore(core, currentCore));
    }

    return true;
  }

  resetToDefault(): void {
    this.removeStoredLayout();
    this.commitLayout(this.normalizeLayout(DEFAULT_APP_STORE_LAYOUT), false);
  }

  private loadLayout(): AppStoreLayout {
    const storedLayout = this.readStoredLayout();
    return this.normalizeLayout(storedLayout || DEFAULT_APP_STORE_LAYOUT);
  }

  private readStoredLayout(): AppStoreLayout | null {
    try {
      const stored = localStorage.getItem(APP_STORE_STORAGE_KEY);
      if (!stored) {
        return null;
      }

      const parsed = JSON.parse(stored);
      if (parsed?.zones) {
        return {
          version: 2,
          zones: {
            header: parsed.zones.header || []
          }
        };
      }

      return {
        version: 2,
        zones: {
          header: parsed?.header || []
        }
      };
    } catch (error) {
      console.error('Failed to load app store layout:', error);
      return null;
    }
  }

  private commitLayout(layout: AppStoreLayout, persist = true): void {
    const normalizedLayout = this.normalizeLayout(layout);
    this.layoutSubject.next(normalizedLayout);

    if (persist) {
      this.saveLayout(normalizedLayout);
    }
  }

  private saveLayout(layout: AppStoreLayout): void {
    try {
      localStorage.setItem(APP_STORE_STORAGE_KEY, JSON.stringify(layout));
    } catch (error) {
      console.error('Failed to save app store layout:', error);
    }
  }

  private removeStoredLayout(): void {
    try {
      localStorage.removeItem(APP_STORE_STORAGE_KEY);
      localStorage.removeItem('app-store-config');
    } catch (error) {
      console.error('Failed to reset app store layout:', error);
    }
  }

  private normalizeLayout(layout: AppStoreLayout): AppStoreLayout {
    return {
      version: 2,
      zones: {
        header: this.sanitizeZoneIds('header', layout.zones.header || [])
      }
    };
  }

  private sanitizeZoneIds(zone: AppPlacementZone, appIds: string[]): string[] {
    const limit = this.getZoneLimit(zone);
    const seen = new Set<string>();
    const result: string[] = [];

    for (const appId of appIds) {
      if (result.length >= limit) {
        break;
      }

      if (seen.has(appId) || !this.canRegisterApp(appId)) {
        continue;
      }

      seen.add(appId);
      result.push(appId);
    }

    return result;
  }

  private canRegisterApp(appId: string): boolean {
    const app = this.appMap.get(appId);
    return !!app && app.enabled !== false;
  }

  private cloneLayout(layout: AppStoreLayout): AppStoreLayout {
    return {
      version: 2,
      zones: {
        header: [...layout.zones.header]
      }
    };
  }

  private matchesAppCore(appCore: string, currentCore: string): boolean {
    const normalizedAppCore = appCore.toLowerCase();
    return currentCore === normalizedAppCore || currentCore.split(':').includes(normalizedAppCore);
  }
}
