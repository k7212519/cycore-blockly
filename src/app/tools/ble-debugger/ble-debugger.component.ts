import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { Subscription } from 'rxjs';
import { SubWindowComponent } from '../../components/sub-window/sub-window.component';
import { ToolContainerComponent } from '../../components/tool-container/tool-container.component';
import { ToolI18nService } from '../../services/tool-i18n.service';
import { UiService } from '../../services/ui.service';
import {
  BleBackendEvent,
  BleDebuggerBackendService,
  BleDebuggerDevice,
  BleGattCharacteristic,
  BleGattService
} from './ble-debugger-backend.service';

type BackendStatus = 'idle' | 'starting' | 'ready' | 'error' | 'closed';
type BleLogType = 'system' | 'scan' | 'connect' | 'rx' | 'tx' | 'notify' | 'error';
type PayloadMode = 'hex' | 'ascii';

interface BleLogEntry {
  id: number;
  time: string;
  type: BleLogType;
  label: string;
  detail?: string;
  value?: string;
}

@Component({
  selector: 'app-ble-debugger',
  imports: [
    CommonModule,
    FormsModule,
    TranslateModule,
    SubWindowComponent,
    ToolContainerComponent
  ],
  templateUrl: './ble-debugger.component.html',
  styleUrl: './ble-debugger.component.scss'
})
export class BleDebuggerComponent implements OnInit, OnDestroy {
  currentUrl = '';
  backendStatus: BackendStatus = 'idle';
  adapterState = 'unknown';
  backendPid = 0;

  scanning = false;
  allowDuplicates = true;
  serviceFilter = '';
  devices: BleDebuggerDevice[] = [];
  selectedDeviceId = '';
  connectedDeviceId = '';
  connectingDeviceId = '';

  services: BleGattService[] = [];
  selectedServiceUuid = '';
  selectedCharacteristicUuid = '';

  payloadMode: PayloadMode = 'hex';
  payload = '01 02 03 04';
  writeWithoutResponse = false;

  logs: BleLogEntry[] = [];

  private logSeq = 0;
  private eventSub?: Subscription;

  constructor(
    private router: Router,
    private uiService: UiService,
    private toolI18n: ToolI18nService,
    private backend: BleDebuggerBackendService
  ) { }

  ngOnInit(): void {
    void this.initTool();
  }

  ngOnDestroy(): void {
    this.eventSub?.unsubscribe();
    void this.backend.stop();
  }

  private async initTool(): Promise<void> {
    await this.toolI18n.load('ble-debugger');
    this.currentUrl = this.router.url;
    this.eventSub = this.backend.events$.subscribe(event => this.handleBackendEvent(event));
    await this.startBackend();
  }

  close(): void {
    this.uiService.closeTool('ble-debugger');
  }

  async startBackend(): Promise<void> {
    if (this.backendStatus === 'starting' || this.backendStatus === 'ready') {
      return;
    }

    this.backendStatus = 'starting';
    try {
      await this.backend.start();
      const status = await this.backend.request<{ state: string; scanning: boolean; connected: boolean }>('status');
      this.adapterState = status.state || this.adapterState;
      this.scanning = !!status.scanning;
      this.backendStatus = 'ready';
      this.pushLog('system', 'BLE_DEBUGGER.BACKEND_READY');
    } catch (error) {
      this.backendStatus = 'error';
      this.pushLog('error', 'BLE_DEBUGGER.BACKEND_FAILED', this.errorMessage(error));
    }
  }

  async restartBackend(): Promise<void> {
    await this.backend.stop();
    this.backendStatus = 'closed';
    this.adapterState = 'unknown';
    this.scanning = false;
    this.connectedDeviceId = '';
    this.connectingDeviceId = '';
    this.services = [];
    await this.startBackend();
  }

  async startScan(): Promise<void> {
    if (!await this.ensureReady()) return;

    const serviceUuids = this.parseServiceFilter();
    if (serviceUuids === null) {
      return;
    }

    try {
      await this.backend.request('startScan', {
        serviceUuids,
        allowDuplicates: this.allowDuplicates
      });
      this.scanning = true;
      this.pushLog('scan', 'BLE_DEBUGGER.SCAN_STARTED');
    } catch (error) {
      this.pushLog('error', 'BLE_DEBUGGER.SCAN_FAILED', this.errorMessage(error));
    }
  }

  async stopScan(): Promise<void> {
    if (!await this.ensureReady()) return;
    try {
      await this.backend.request('stopScan');
      this.scanning = false;
      this.pushLog('scan', 'BLE_DEBUGGER.SCAN_STOPPED');
    } catch (error) {
      this.pushLog('error', 'BLE_DEBUGGER.SCAN_FAILED', this.errorMessage(error));
    }
  }

  async connect(device: BleDebuggerDevice): Promise<void> {
    if (!await this.ensureReady()) return;
    this.selectedDeviceId = device.id;
    this.connectingDeviceId = device.id;

    try {
      const result = await this.backend.request<{ device: BleDebuggerDevice; services: BleGattService[] }>('connect', {
        id: device.id
      }, 30000);
      this.connectedDeviceId = result.device.id;
      this.services = result.services || [];
      this.selectFirstCharacteristic();
      this.pushLog('connect', 'BLE_DEBUGGER.DEVICE_CONNECTED', this.deviceTitle(result.device));
    } catch (error) {
      this.pushLog('error', 'BLE_DEBUGGER.CONNECT_FAILED', this.errorMessage(error));
    } finally {
      this.connectingDeviceId = '';
    }
  }

  async disconnect(): Promise<void> {
    if (!await this.ensureReady()) return;
    try {
      await this.backend.request('disconnect');
      this.connectedDeviceId = '';
      this.services = [];
      this.selectedServiceUuid = '';
      this.selectedCharacteristicUuid = '';
      this.pushLog('connect', 'BLE_DEBUGGER.DEVICE_DISCONNECTED');
    } catch (error) {
      this.pushLog('error', 'BLE_DEBUGGER.DISCONNECT_FAILED', this.errorMessage(error));
    }
  }

  async refreshGatt(): Promise<void> {
    if (!await this.ensureReady()) return;
    if (!this.connectedDeviceId) return;

    try {
      const result = await this.backend.request<{ services: BleGattService[] }>('discoverGatt', {}, 30000);
      this.services = result.services || [];
      this.selectFirstCharacteristic();
      this.pushLog('system', 'BLE_DEBUGGER.GATT_REFRESHED');
    } catch (error) {
      this.pushLog('error', 'BLE_DEBUGGER.GATT_FAILED', this.errorMessage(error));
    }
  }

  selectCharacteristic(service: BleGattService, characteristic: BleGattCharacteristic): void {
    this.selectedServiceUuid = service.uuid;
    this.selectedCharacteristicUuid = characteristic.uuid;
  }

  async readSelected(): Promise<void> {
    const characteristic = this.selectedCharacteristic;
    if (!characteristic || !this.canRead(characteristic)) return;

    try {
      const result = await this.backend.request<any>('read', {
        serviceUuid: characteristic.rawServiceUuid,
        characteristicUuid: characteristic.rawUuid
      });
      this.updateCharacteristic(result.serviceUuid, result.characteristicUuid, {
        lastValueHex: result.valueHex,
        lastValueAscii: result.valueAscii
      });
      this.pushLog('rx', 'BLE_DEBUGGER.READ_OK', `${result.characteristicUuid}, ${result.byteLength} B`, result.valueHex);
    } catch (error) {
      this.pushLog('error', 'BLE_DEBUGGER.READ_FAILED', this.errorMessage(error));
    }
  }

  async writeSelected(): Promise<void> {
    const characteristic = this.selectedCharacteristic;
    if (!characteristic || !this.canWrite(characteristic)) return;

    try {
      const result = await this.backend.request<any>('write', {
        serviceUuid: characteristic.rawServiceUuid,
        characteristicUuid: characteristic.rawUuid,
        mode: this.payloadMode,
        payload: this.payload,
        withoutResponse: this.writeWithoutResponse
      });
      this.pushLog('tx', 'BLE_DEBUGGER.WRITE_OK', `${result.characteristicUuid}, ${result.byteLength} B`, result.valueHex);
    } catch (error) {
      this.pushLog('error', 'BLE_DEBUGGER.WRITE_FAILED', this.errorMessage(error));
    }
  }

  async toggleNotify(): Promise<void> {
    const characteristic = this.selectedCharacteristic;
    if (!characteristic || !this.canNotify(characteristic)) return;

    const action = characteristic.notifying ? 'unsubscribe' : 'subscribe';
    try {
      const result = await this.backend.request<any>(action, {
        serviceUuid: characteristic.rawServiceUuid,
        characteristicUuid: characteristic.rawUuid
      });
      this.updateCharacteristic(result.serviceUuid, result.characteristicUuid, {
        notifying: action === 'subscribe'
      });
      this.pushLog(
        'notify',
        action === 'subscribe' ? 'BLE_DEBUGGER.NOTIFY_ENABLED' : 'BLE_DEBUGGER.NOTIFY_DISABLED',
        result.characteristicUuid
      );
    } catch (error) {
      this.pushLog('error', 'BLE_DEBUGGER.NOTIFY_FAILED', this.errorMessage(error));
    }
  }

  clearDevices(): void {
    this.devices = [];
  }

  clearLogs(): void {
    this.logs = [];
  }

  get selectedDevice(): BleDebuggerDevice | undefined {
    return this.devices.find(device => device.id === this.selectedDeviceId);
  }

  get selectedCharacteristic(): BleGattCharacteristic | undefined {
    for (const service of this.services) {
      const match = service.characteristics.find(characteristic =>
        characteristic.uuid === this.selectedCharacteristicUuid &&
        service.uuid === this.selectedServiceUuid
      );
      if (match) return match;
    }
    return undefined;
  }

  get backendStatusKey(): string {
    return `BLE_DEBUGGER.BACKEND_${this.backendStatus.toUpperCase()}`;
  }

  get adapterStatusKey(): string {
    const normalized = this.adapterState.replace(/[^a-z0-9]/gi, '_').toUpperCase();
    return `BLE_DEBUGGER.ADAPTER_${normalized || 'UNKNOWN'}`;
  }

  deviceTitle(device: BleDebuggerDevice): string {
    return `${device.name || 'Unknown'} (${device.address || device.id})`;
  }

  rssiClass(device: BleDebuggerDevice): string {
    if (device.rssi === null || device.rssi === undefined) return 'weak';
    if (device.rssi >= -60) return 'strong';
    if (device.rssi >= -78) return 'medium';
    return 'weak';
  }

  hasProperty(characteristic: BleGattCharacteristic | undefined, property: string): boolean {
    return !!characteristic?.properties?.includes(property);
  }

  canRead(characteristic: BleGattCharacteristic | undefined): boolean {
    return this.hasProperty(characteristic, 'read');
  }

  canWrite(characteristic: BleGattCharacteristic | undefined): boolean {
    return this.hasProperty(characteristic, 'write') || this.hasProperty(characteristic, 'writeWithoutResponse');
  }

  canNotify(characteristic: BleGattCharacteristic | undefined): boolean {
    return this.hasProperty(characteristic, 'notify') || this.hasProperty(characteristic, 'indicate');
  }

  private async ensureReady(): Promise<boolean> {
    if (this.backendStatus === 'ready') {
      return true;
    }
    await this.startBackend();
    return this.backend.isRunning;
  }

  private handleBackendEvent(event: BleBackendEvent): void {
    switch (event.event) {
      case 'ready':
        this.backendPid = Number(event.data?.pid) || 0;
        this.adapterState = event.data?.state || this.adapterState;
        this.backendStatus = 'ready';
        break;
      case 'state':
        this.adapterState = event.data?.state || 'unknown';
        this.scanning = !!event.data?.scanning;
        break;
      case 'scanStart':
        this.scanning = true;
        break;
      case 'scanStop':
        this.scanning = false;
        break;
      case 'device':
        this.upsertDevice(event.data as BleDebuggerDevice);
        break;
      case 'connected':
        this.connectedDeviceId = event.data?.device?.id || this.connectedDeviceId;
        this.services = event.data?.services || this.services;
        this.selectFirstCharacteristic();
        break;
      case 'disconnected':
        this.connectedDeviceId = '';
        this.services = [];
        this.selectedServiceUuid = '';
        this.selectedCharacteristicUuid = '';
        break;
      case 'notification':
        this.handleNotification(event.data || {});
        break;
      case 'fatal':
      case 'error':
        this.backendStatus = 'error';
        this.pushLog('error', 'BLE_DEBUGGER.BACKEND_FAILED', event.data?.message || '');
        break;
      case 'close':
        this.backendStatus = 'closed';
        this.scanning = false;
        break;
      case 'log':
        this.pushLog('system', 'BLE_DEBUGGER.BACKEND_LOG', event.data?.message || '');
        break;
      default:
        break;
    }
  }

  private upsertDevice(device: BleDebuggerDevice): void {
    if (!device?.id) return;
    const index = this.devices.findIndex(item => item.id === device.id);
    if (index >= 0) {
      this.devices[index] = { ...this.devices[index], ...device };
    } else {
      this.devices.unshift(device);
    }

    this.devices = [...this.devices]
      .sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999))
      .slice(0, 120);
  }

  private handleNotification(data: any): void {
    this.updateCharacteristic(data.serviceUuid, data.characteristicUuid, {
      lastValueHex: data.valueHex,
      lastValueAscii: data.valueAscii,
      notifying: true
    });
    this.pushLog('notify', 'BLE_DEBUGGER.NOTIFICATION', `${data.characteristicUuid}, ${data.byteLength} B`, data.valueHex);
  }

  private updateCharacteristic(serviceUuid: string, characteristicUuid: string, patch: Partial<BleGattCharacteristic>): void {
    this.services = this.services.map(service => {
      if (service.uuid !== serviceUuid) return service;
      return {
        ...service,
        characteristics: service.characteristics.map(characteristic =>
          characteristic.uuid === characteristicUuid ? { ...characteristic, ...patch } : characteristic
        )
      };
    });
  }

  private selectFirstCharacteristic(): void {
    const firstService = this.services[0];
    const firstCharacteristic = firstService?.characteristics?.[0];
    if (!firstService || !firstCharacteristic) {
      this.selectedServiceUuid = '';
      this.selectedCharacteristicUuid = '';
      return;
    }

    const stillExists = this.services.some(service =>
      service.uuid === this.selectedServiceUuid &&
      service.characteristics.some(characteristic => characteristic.uuid === this.selectedCharacteristicUuid)
    );

    if (!stillExists) {
      this.selectedServiceUuid = firstService.uuid;
      this.selectedCharacteristicUuid = firstCharacteristic.uuid;
    }
  }

  private parseServiceFilter(): string[] | null {
    const tokens = this.serviceFilter
      .split(/[\s,;]+/)
      .map(token => token.trim())
      .filter(Boolean);

    for (const token of tokens) {
      const normalized = token.replace(/^0x/i, '').replace(/-/g, '');
      if (!/^[a-fA-F0-9]{4}$|^[a-fA-F0-9]{32}$/.test(normalized)) {
        this.pushLog('error', 'BLE_DEBUGGER.INVALID_UUID', token);
        return null;
      }
    }

    return tokens;
  }

  private pushLog(type: BleLogType, label: string, detail = '', value = ''): void {
    this.logs.unshift({
      id: ++this.logSeq,
      time: new Date().toLocaleTimeString(),
      type,
      label,
      detail,
      value
    });
    this.logs = this.logs.slice(0, 160);
  }

  private errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error || '');
  }
}
