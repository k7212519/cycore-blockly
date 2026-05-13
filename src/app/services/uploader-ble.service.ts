import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { IMenuItem } from '../configs/menu.config';

const BLE_OTA_SERVICE_UUID = '00008018-0000-1000-8000-00805f9b34fb';
const BLE_OTA_RECV_FW_CHAR_UUID = '00008020-0000-1000-8000-00805f9b34fb';
const BLE_OTA_COMMAND_CHAR_UUID = '00008022-0000-1000-8000-00805f9b34fb';
const DEVICE_INFORMATION_SERVICE_UUID = '0000180a-0000-1000-8000-00805f9b34fb';

const SECTOR_SIZE = 4096;
const COMMAND_FRAME_SIZE = 20;
const CMD_START_FLASH = 0x0001;
const CMD_STOP = 0x0002;
const CMD_ACK = 0x0003;
const CMD_START_FILESYSTEM = 0x0004;
const ACK_OK = 0x0000;
const ACK_CRC_ERROR = 0x0001;
const ACK_INDEX_ERROR = 0x0002;
const ACK_SIGNATURE_ERROR = 0x0003;
const ACK_START_ERROR = 0x0005;
const COMMAND_ACK_TIMEOUT_MS = 15000;
const STOP_COMMAND_ACK_TIMEOUT_MS = 45000;
const STOP_COMMAND_RETRY_TIMEOUT_MS = 15000;
const DEFAULT_SCAN_TIMEOUT_MS = 3000;
const GATT_CONNECT_MAX_ATTEMPTS = 3;
const GATT_CONNECT_RETRY_DELAY_MS = 800;

export type BleOtaUpdateType = 'flash' | 'filesystem';

export interface BleOtaDeviceItem {
  id: string;
  name: string;
  device?: any;
  connected?: boolean;
  source?: 'web-bluetooth' | 'electron-scan';
}

export interface BleOtaScanState {
  scanning: boolean;
  devices: BleOtaDeviceItem[];
}

export interface BleOtaProgress {
  state: 'connecting' | 'probing' | 'starting' | 'sending' | 'stopping' | 'done';
  progress: number;
  text?: string;
  sectorIndex?: number;
  sectorCount?: number;
  bytesSent?: number;
  totalBytes?: number;
  speed?: number;
}

export interface BleOtaUploadOptions {
  updateType?: BleOtaUpdateType;
  packetSize?: number;
  retries?: number;
  progress?: (progress: BleOtaProgress) => void;
  signal?: AbortSignal;
}

export interface BleOtaUploadResult {
  success: boolean;
  bytes: number;
  elapsedMs: number;
  deviceName?: string;
}

export interface BleOtaTransport {
  beginScan(timeoutMs?: number): Promise<BleOtaDeviceItem>;
  cancelScan(): Promise<void>;
  selectDevice(deviceId: string): Promise<BleOtaDeviceItem>;
  connect(deviceId?: string, progress?: (progress: BleOtaProgress) => void): Promise<void>;
  disconnect(): Promise<void>;
  uploadFirmware(firmware: Uint8Array | ArrayBuffer, options?: BleOtaUploadOptions): Promise<BleOtaUploadResult>;
  cancel(): void;
}

interface BleOtaCommandAck {
  commandId: number;
  status: number;
}

interface BleOtaSectorAck {
  sectorIndex: number;
  status: number;
  expectedIndex: number;
}

interface PendingCommandAck {
  commandId: number;
  resolve: (ack: BleOtaCommandAck) => void;
  reject: (error: any) => void;
  timer: any;
}

interface PendingSectorAck {
  sectorIndex: number;
  resolve: (ack: BleOtaSectorAck) => void;
  reject: (error: any) => void;
  timer: any;
}

@Injectable({
  providedIn: 'root'
})
export class UploaderBleService implements BleOtaTransport {
  readonly devicesChanged = new BehaviorSubject<BleOtaDeviceItem[]>([]);
  readonly scanStateChanged = new BehaviorSubject<BleOtaScanState>({ scanning: false, devices: [] });

  private knownDevices = new Map<string, BleOtaDeviceItem>();
  private discoveredDevices = new Map<string, BleOtaDeviceItem>();
  private selectedDeviceId: string | null = null;
  private scanPromise: Promise<BleOtaDeviceItem> | null = null;
  private searching = false;
  private scanTimeoutTimer: any = null;
  private bridgeInitialized = false;
  private removeBridgeDeviceListListener?: () => void;
  private emitLogTimer: any = null;

  private server: any = null;
  private recvFwCharacteristic: any = null;
  private commandCharacteristic: any = null;
  private pendingCommandAcks: PendingCommandAck[] = [];
  private pendingSectorAcks: PendingSectorAck[] = [];
  private cancelRequested = false;

  private readonly handleCommandNotification = (event: any) => {
    const data = this.getEventBytes(event);
    if (data.length < COMMAND_FRAME_SIZE) return;
    if (!this.isFrameCrcValid(data)) return;

    const frameCommand = this.readUint16LE(data, 0);
    if (frameCommand !== CMD_ACK) return;

    const ack: BleOtaCommandAck = {
      commandId: this.readUint16LE(data, 2),
      status: this.readUint16LE(data, 4),
    };

    const pending = this.pendingCommandAcks.find(item => item.commandId === ack.commandId) || this.pendingCommandAcks[0];
    if (!pending) return;

    this.pendingCommandAcks = this.pendingCommandAcks.filter(item => item !== pending);
    clearTimeout(pending.timer);
    pending.resolve(ack);
  };

  private readonly handleFirmwareNotification = (event: any) => {
    const data = this.getEventBytes(event);
    if (data.length < COMMAND_FRAME_SIZE) return;
    if (!this.isFrameCrcValid(data)) return;

    const ack: BleOtaSectorAck = {
      sectorIndex: this.readUint16LE(data, 0),
      status: this.readUint16LE(data, 2),
      expectedIndex: this.readUint16LE(data, 4),
    };

    const pending = this.pendingSectorAcks.find(item => item.sectorIndex === ack.sectorIndex) || this.pendingSectorAcks[0];
    if (!pending) return;

    this.pendingSectorAcks = this.pendingSectorAcks.filter(item => item !== pending);
    clearTimeout(pending.timer);
    pending.resolve(ack);
  };

  private readonly handleGattDisconnected = (event: any) => {
    const device = event?.target;
    if (device?.id && this.knownDevices.has(device.id)) {
      const cached = this.knownDevices.get(device.id);
      this.knownDevices.set(device.id, { ...cached, connected: false });
      this.emitDevices(this.isScanning());
    }
    this.rejectPendingAcks(new Error('BLE 设备已断开'));
    this.server = null;
    this.recvFwCharacteristic = null;
    this.commandCharacteristic = null;
  };

  isSupported(): boolean {
    return !!this.getBluetooth()?.requestDevice;
  }

  isScanning(): boolean {
    return this.searching;
  }

  hasActiveRequest(): boolean {
    return !!this.scanPromise;
  }

  getSelectedDevice(): BleOtaDeviceItem | null {
    if (!this.selectedDeviceId) return null;
    return this.knownDevices.get(this.selectedDeviceId) || this.discoveredDevices.get(this.selectedDeviceId) || null;
  }

  getDevices(): BleOtaDeviceItem[] {
    const merged = new Map<string, BleOtaDeviceItem>();

    this.knownDevices.forEach(device => merged.set(device.id, device));
    this.discoveredDevices.forEach(device => {
      const duplicateKnownDevice = Array.from(this.knownDevices.values()).some(knownDevice => (
        this.getDeviceDedupKey(knownDevice) === this.getDeviceDedupKey(device)
      ));
      if (!duplicateKnownDevice) {
        merged.set(device.id, device);
      }
    });

    return Array.from(merged.values());
  }

  getPortMenuItems(currentPort?: string): IMenuItem[] {
    const items: IMenuItem[] = [];
    const supported = this.isSupported();
    const scanning = this.isScanning();
    const devices = this.getDevices();

    this.debug('build port menu items', {
      supported,
      scanning,
      currentPort,
      deviceCount: devices.length,
      devices: devices.map(device => ({ id: device.id, name: device.name, source: device.source }))
    });

    items.push({
      name: scanning ? '正在搜索BLE设备' : '搜索BLE设备',
      // text: supported ? 'Web Bluetooth' : 'Not supported',
      action: supported && !scanning ? 'ble-scan' : undefined,
      type: 'ble-action',
      icon: scanning ? 'fa-light fa-spinner-third fa-spin' : 'fa-light fa-magnifying-glass',
      disabled: !supported || scanning,
    });

    for (const device of devices) {
      items.push({
        name: device.name || 'BLE OTA Device',
        text: 'BLE OTA',
        type: 'ble',
        icon: 'fa-light fa-bluetooth',
        current: currentPort === device.id,
        extra: {
          deviceId: device.id,
          source: device.source,
        },
      } as IMenuItem);
    }

    return items;
  }

  async refreshGrantedDevices(): Promise<BleOtaDeviceItem[]> {
    const bluetooth = this.getBluetooth();
    if (!bluetooth?.getDevices) return this.getDevices();

    try {
      const devices = await bluetooth.getDevices();
      for (const device of devices || []) {
        this.cacheBluetoothDevice(device);
      }
      this.emitDevices(this.isScanning());
    } catch (error) {
      console.warn('读取已授权 BLE 设备失败:', error);
    }

    return this.getDevices();
  }

  async beginScan(timeoutMs = DEFAULT_SCAN_TIMEOUT_MS): Promise<BleOtaDeviceItem> {
    if (this.scanPromise) {
      this.startSearchWindow(timeoutMs);
      return this.scanPromise;
    }

    const bluetooth = this.getBluetooth();
    this.debug('beginScan called', {
      hasBluetooth: !!bluetooth,
      hasRequestDevice: !!bluetooth?.requestDevice,
      hasBridge: !!window['ble']?.onDeviceList,
      userAgent: navigator.userAgent,
    });

    if (!bluetooth?.requestDevice) {
      throw new Error('当前环境不支持 Web Bluetooth');
    }

    if (this.isElectronRuntime() && !window['ble']?.onDeviceList) {
      throw new Error('BLE 扫描桥接未加载，请重启 Electron 应用后重试');
    }

    this.setupElectronBluetoothBridge();
    this.discoveredDevices.clear();
    this.startSearchWindow(timeoutMs);

    const requestOptions = {
      filters: [{ services: [BLE_OTA_SERVICE_UUID] }],
      optionalServices: [BLE_OTA_SERVICE_UUID, DEVICE_INFORMATION_SERVICE_UUID],
    };

    this.debug('calling navigator.bluetooth.requestDevice', requestOptions);

    window['ble']?.debugState?.().then(state => {
      this.debug('main debug state before requestDevice', state);
    }).catch(error => {
      this.debug('main debug state failed', error?.message || error);
    });

    this.scanPromise = bluetooth.requestDevice(requestOptions)
      .then((device: any) => {
        this.debug('requestDevice resolved', {
          id: device?.id,
          name: device?.name,
          hasGatt: !!device?.gatt,
        });
        const item = this.cacheBluetoothDevice(device);
        this.selectedDeviceId = item.id;
        return this.releaseDeviceConnection(item, 'scan selection');
      })
      .catch(error => {
        this.debug('requestDevice rejected', error?.message || error);
        throw error;
      })
      .finally(() => {
        this.debug('requestDevice finished');
        this.clearSearchTimeout();
        this.searching = false;
        window['ble']?.stopDeviceListUpdates?.().catch?.(() => undefined);
        this.scanPromise = null;
        this.emitDevices(false);
      });

    return this.scanPromise;
  }

  async cancelScan(): Promise<void> {
    if (!this.scanPromise && !this.searching) return;

    try {
      this.clearSearchTimeout();
      this.searching = false;
      await window['ble']?.stopDeviceListUpdates?.().catch?.(() => undefined);
      if (window['ble']?.cancelDeviceRequest) {
        await window['ble'].cancelDeviceRequest();
      }
    } catch (error) {
      console.warn('取消 BLE 扫描失败:', error);
    } finally {
      this.emitDevices(false);
    }
  }

  async selectDevice(deviceId: string): Promise<BleOtaDeviceItem> {
    if (!deviceId) throw new Error('BLE 设备 ID 为空');

    const cached = this.knownDevices.get(deviceId);
    if (cached?.device) {
      this.selectedDeviceId = deviceId;
      const selected = this.releaseDeviceConnection(cached, 'device selection');
      this.emitDevices(this.isScanning());
      return selected;
    }

    if (this.scanPromise && window['ble']?.selectDevice) {
      const discovered = this.discoveredDevices.get(deviceId);
      const result = await window['ble'].selectDevice(deviceId);
      if (result?.success === false) {
        throw new Error(result.error || '选择 BLE 设备失败');
      }
      const selected = await this.scanPromise;
      this.selectedDeviceId = selected.id;
      this.removeDiscoveredDuplicates(selected, deviceId, discovered?.name);
      return this.releaseDeviceConnection(selected, 'device selection');
    }

    const discovered = this.discoveredDevices.get(deviceId);
    if (discovered) {
      throw new Error('请重新扫描并授权该 BLE 设备');
    }

    throw new Error('未找到 BLE 设备');
  }

  async connect(deviceId?: string, progress?: (progress: BleOtaProgress) => void): Promise<void> {
    const deviceItem = await this.ensureDevice(deviceId || this.selectedDeviceId || undefined);
    const device = deviceItem.device;
    if (!device?.gatt) {
      throw new Error('BLE 设备未授权，请重新扫描选择');
    }

    if (device.gatt.connected && this.recvFwCharacteristic && this.commandCharacteristic) {
      return;
    }

    await this.disconnect();
    this.server = await this.connectGattWithRetry(deviceItem, progress);
    const otaService = await this.server.getPrimaryService(BLE_OTA_SERVICE_UUID);
    this.recvFwCharacteristic = await otaService.getCharacteristic(BLE_OTA_RECV_FW_CHAR_UUID);
    this.commandCharacteristic = await otaService.getCharacteristic(BLE_OTA_COMMAND_CHAR_UUID);

    await this.commandCharacteristic.startNotifications();
    await this.recvFwCharacteristic.startNotifications();
    this.commandCharacteristic.addEventListener('characteristicvaluechanged', this.handleCommandNotification);
    this.recvFwCharacteristic.addEventListener('characteristicvaluechanged', this.handleFirmwareNotification);

    this.knownDevices.set(deviceItem.id, { ...deviceItem, connected: true });
    this.selectedDeviceId = deviceItem.id;
    this.emitDevices(this.isScanning());
  }

  async disconnect(): Promise<void> {
    try {
      if (this.commandCharacteristic) {
        this.commandCharacteristic.removeEventListener('characteristicvaluechanged', this.handleCommandNotification);
        if (this.commandCharacteristic.service?.device?.gatt?.connected) {
          await this.commandCharacteristic.stopNotifications().catch(() => undefined);
        }
      }
      if (this.recvFwCharacteristic) {
        this.recvFwCharacteristic.removeEventListener('characteristicvaluechanged', this.handleFirmwareNotification);
        if (this.recvFwCharacteristic.service?.device?.gatt?.connected) {
          await this.recvFwCharacteristic.stopNotifications().catch(() => undefined);
        }
      }
    } finally {
      const selected = this.getSelectedDevice();
      if (selected?.device?.gatt?.connected) {
        selected.device.gatt.disconnect();
      }
      this.server = null;
      this.recvFwCharacteristic = null;
      this.commandCharacteristic = null;
      this.rejectPendingAcks(new Error('BLE 连接已关闭'));
    }
  }

  async uploadFirmware(firmware: Uint8Array | ArrayBuffer, options: BleOtaUploadOptions = {}): Promise<BleOtaUploadResult> {
    const data = firmware instanceof Uint8Array ? firmware : new Uint8Array(firmware);
    if (!data.byteLength) throw new Error('固件为空');

    const startTime = Date.now();
    this.cancelRequested = false;

    const emitProgress = (progress: BleOtaProgress) => {
      options.progress?.(progress);
    };

    try {
      this.throwIfCancelled(options.signal);
      emitProgress({ state: 'connecting', progress: 0, text: '正在连接 BLE 设备...' });
      await this.connect(undefined, emitProgress);

      this.throwIfCancelled(options.signal);
      emitProgress({ state: 'probing', progress: 1, text: '正在协商 BLE 包大小...' });
      const packetSize = options.packetSize || await this.probePacketSize();

      this.throwIfCancelled(options.signal);
      emitProgress({ state: 'starting', progress: 2, text: '正在启动 OTA...' });
      await this.sendStartCommand(options.updateType || 'flash', data.byteLength);

      await this.sendFirmware(data, packetSize, {
        ...options,
        progress: emitProgress,
      });

      this.throwIfCancelled(options.signal);
      emitProgress({ state: 'stopping', progress: 99, text: '正在校验并更新固件...' });
      await this.sendStopCommand();

      const elapsedMs = Date.now() - startTime;
      emitProgress({
        state: 'done',
        progress: 100,
        text: 'BLE OTA完成',
        bytesSent: data.byteLength,
        totalBytes: data.byteLength,
        speed: elapsedMs > 0 ? Math.round(data.byteLength / (elapsedMs / 1000)) : 0,
      });

      return {
        success: true,
        bytes: data.byteLength,
        elapsedMs,
        deviceName: this.getSelectedDevice()?.name,
      };
    } catch (error) {
      if (this.cancelRequested || options.signal?.aborted) {
        throw new Error('上传已取消');
      }
      throw error;
    }
  }

  cancel(): void {
    this.cancelRequested = true;
    this.rejectPendingAcks(new Error('上传已取消'));
  }

  findFirmwareFile(buildPath: string): string {
    if (!buildPath || !window['fs']?.existsSync(buildPath)) return '';

    const files = this.collectFiles(buildPath)
      .filter(filePath => filePath.toLowerCase().endsWith('.bin'));

    const appBins = files.filter(filePath => {
      const name = window['path'].basename(filePath).toLowerCase();
      return !/(bootloader|partition|boot_app0|ota_data|spiffs|littlefs|filesystem|fatfs)/.test(name);
    });

    return appBins.find(filePath => window['path'].basename(filePath).toLowerCase().endsWith('.ino.bin'))
      || appBins[0]
      || '';
  }

  readFirmwareFile(filePath: string): Uint8Array {
    const base64 = window['fs'].readFileAsBase64(filePath);
    return this.base64ToBytes(base64);
  }

  private async sendFirmware(data: Uint8Array, packetSize: number, options: BleOtaUploadOptions): Promise<void> {
    const sectorCount = Math.ceil(data.byteLength / SECTOR_SIZE);
    const retries = options.retries ?? 3;
    const payloadSize = packetSize - 5;
    if (payloadSize <= 0) throw new Error(`BLE 包大小异常: ${packetSize}`);

    let sectorIndex = 0;
    const startTime = Date.now();

    while (sectorIndex < sectorCount) {
      let sent = false;
      let attempt = 0;

      while (!sent && attempt <= retries) {
        this.throwIfCancelled(options.signal);
        const sectorStart = sectorIndex * SECTOR_SIZE;
        const sectorEnd = Math.min(sectorStart + SECTOR_SIZE, data.byteLength);
        const sector = data.subarray(sectorStart, sectorEnd);

        const ackPromise = this.waitForSectorAck(sectorIndex);
        await this.writeSector(sectorIndex, sector, payloadSize, data.byteLength, startTime, options.progress, options.signal);
        const ack = await ackPromise;

        if (ack.status === ACK_OK) {
          sectorIndex++;
          sent = true;
          break;
        }

        if (ack.status === ACK_INDEX_ERROR && ack.expectedIndex >= 0 && ack.expectedIndex < sectorCount) {
          sectorIndex = ack.expectedIndex;
          sent = true;
          break;
        }

        attempt++;
      }

      if (!sent) {
        throw new Error(`Sector ${sectorIndex} 重试失败`);
      }
    }
  }

  private async writeSector(
    sectorIndex: number,
    sector: Uint8Array,
    payloadSize: number,
    totalBytes: number,
    startTime: number,
    progress?: (progress: BleOtaProgress) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const sectorCrc = this.crc16(sector);
    let offset = 0;
    let seq = 0;

    while (offset < sector.byteLength) {
      this.throwIfCancelled(signal);
      const chunkSize = Math.min(payloadSize, sector.byteLength - offset);
      const isLast = offset + chunkSize >= sector.byteLength;
      const packet = new Uint8Array(3 + chunkSize + (isLast ? 2 : 0));
      this.writeUint16LE(packet, 0, sectorIndex);
      packet[2] = isLast ? 0xff : seq++;
      packet.set(sector.subarray(offset, offset + chunkSize), 3);
      if (isLast) {
        this.writeUint16LE(packet, 3 + chunkSize, sectorCrc);
      }

      await this.writeCharacteristic(this.recvFwCharacteristic, packet, true);
      offset += chunkSize;

      const bytesSent = Math.min((sectorIndex * SECTOR_SIZE) + offset, totalBytes);
      const elapsed = Math.max(Date.now() - startTime, 1);
      progress?.({
        state: 'sending',
        progress: Math.max(2, Math.floor((bytesSent / totalBytes) * 98)),
        text: `BLE OTA上传中 ${Math.floor((bytesSent / totalBytes) * 100)}%`,
        sectorIndex,
        sectorCount: Math.ceil(totalBytes / SECTOR_SIZE),
        bytesSent,
        totalBytes,
        speed: Math.round(bytesSent / (elapsed / 1000)),
      });
    }
  }

  private async sendStartCommand(updateType: BleOtaUpdateType, totalSize: number): Promise<void> {
    const commandId = updateType === 'filesystem' ? CMD_START_FILESYSTEM : CMD_START_FLASH;
    await this.sendCommand(commandId, totalSize);
  }

  private async sendStopCommand(): Promise<void> {
    try {
      await this.sendCommand(CMD_STOP, undefined, STOP_COMMAND_ACK_TIMEOUT_MS);
      return;
    } catch (error) {
      if (this.isDisconnectedError(error)) return;
      if (!this.isCommandAckTimeout(error, CMD_STOP)) throw error;
      if (!this.isSelectedGattConnected()) return;

      this.debug('STOP ACK timeout, retrying command once');
    }

    try {
      await this.sendCommand(CMD_STOP, undefined, STOP_COMMAND_RETRY_TIMEOUT_MS);
    } catch (error) {
      if (this.isDisconnectedError(error)) return;
      throw error;
    }
  }

  private async sendCommand(commandId: number, totalSize?: number, timeout = COMMAND_ACK_TIMEOUT_MS): Promise<void> {
    if (!this.commandCharacteristic) throw new Error('BLE OTA 命令特征不可用');

    const frame = this.buildCommandFrame(commandId, totalSize);
    const ackPromise = this.waitForCommandAck(commandId, timeout);
    try {
      await this.writeCharacteristic(this.commandCharacteristic, frame, true);
    } catch (error) {
      this.clearPendingCommandAck(commandId);
      throw error;
    }
    const ack = await ackPromise;

    if (ack.status !== ACK_OK) {
      throw new Error(this.formatAckError(ack.status, commandId));
    }
  }

  private async probePacketSize(): Promise<number> {
    if (!this.recvFwCharacteristic) throw new Error('BLE OTA 固件特征不可用');

    for (const candidate of [510, 247, 185, 122, 23]) {
      try {
        await this.writeCharacteristic(this.recvFwCharacteristic, new Uint8Array(candidate), true);
        return candidate;
      } catch (error) {
        console.warn(`BLE 包大小 ${candidate} 不可用:`, error);
      }
    }

    return 20;
  }

  private waitForCommandAck(commandId: number, timeout = COMMAND_ACK_TIMEOUT_MS): Promise<BleOtaCommandAck> {
    return new Promise((resolve, reject) => {
      const pending: PendingCommandAck = {
        commandId,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.pendingCommandAcks = this.pendingCommandAcks.filter(item => item !== pending);
          reject(new Error(`等待命令 ACK 超时: 0x${commandId.toString(16)}`));
        }, timeout),
      };
      this.pendingCommandAcks.push(pending);
    });
  }

  private clearPendingCommandAck(commandId: number): void {
    const pending = this.pendingCommandAcks.find(item => item.commandId === commandId);
    if (!pending) return;
    this.pendingCommandAcks = this.pendingCommandAcks.filter(item => item !== pending);
    clearTimeout(pending.timer);
  }

  private waitForSectorAck(sectorIndex: number, timeout = 15000): Promise<BleOtaSectorAck> {
    return new Promise((resolve, reject) => {
      const pending: PendingSectorAck = {
        sectorIndex,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.pendingSectorAcks = this.pendingSectorAcks.filter(item => item !== pending);
          reject(new Error(`等待 Sector ${sectorIndex} ACK 超时`));
        }, timeout),
      };
      this.pendingSectorAcks.push(pending);
    });
  }

  private buildCommandFrame(commandId: number, totalSize?: number): Uint8Array {
    const frame = new Uint8Array(COMMAND_FRAME_SIZE);
    this.writeUint16LE(frame, 0, commandId);
    if (typeof totalSize === 'number') {
      this.writeUint32LE(frame, 2, totalSize);
    }
    this.writeUint16LE(frame, 18, this.crc16(frame.subarray(0, 18)));
    return frame;
  }

  private async writeCharacteristic(characteristic: any, data: Uint8Array, withoutResponse: boolean): Promise<void> {
    const value = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    if (withoutResponse && characteristic.writeValueWithoutResponse) {
      await characteristic.writeValueWithoutResponse(value);
      return;
    }
    if (!withoutResponse && characteristic.writeValueWithResponse) {
      await characteristic.writeValueWithResponse(value);
      return;
    }
    await characteristic.writeValue(value);
  }

  private async ensureDevice(deviceId?: string): Promise<BleOtaDeviceItem> {
    await this.refreshGrantedDevices();
    const id = deviceId || this.selectedDeviceId;
    const device = id ? this.knownDevices.get(id) : this.getSelectedDevice();
    if (!device?.device) {
      throw new Error('请先选择 BLE OTA 设备');
    }
    return device;
  }

  private async connectGattWithRetry(
    deviceItem: BleOtaDeviceItem,
    progress?: (progress: BleOtaProgress) => void,
  ): Promise<any> {
    let lastError: any = null;

    for (let attempt = 1; attempt <= GATT_CONNECT_MAX_ATTEMPTS; attempt++) {
      this.throwIfCancelled();

      const retryText = attempt === 1
        ? '正在连接 BLE 设备...'
        : `BLE 连接失败，正在重试 (${attempt}/${GATT_CONNECT_MAX_ATTEMPTS})...`;
      progress?.({ state: 'connecting', progress: 0, text: retryText });

      try {
        this.debug('connecting BLE GATT', {
          id: deviceItem.id,
          name: deviceItem.name,
          attempt,
          maxAttempts: GATT_CONNECT_MAX_ATTEMPTS,
        });
        return await deviceItem.device.gatt.connect();
      } catch (error) {
        lastError = error;
        this.debug('BLE GATT connect failed', {
          id: deviceItem.id,
          name: deviceItem.name,
          attempt,
          maxAttempts: GATT_CONNECT_MAX_ATTEMPTS,
          error: error?.message || error,
        });

        if (!this.isTransientConnectionError(error) || attempt >= GATT_CONNECT_MAX_ATTEMPTS) {
          break;
        }

        this.safeDisconnectGatt(deviceItem.device);
        await this.delay(GATT_CONNECT_RETRY_DELAY_MS * attempt);
      }
    }

    throw lastError || new Error('BLE 连接失败');
  }

  private safeDisconnectGatt(device: any): void {
    try {
      if (device?.gatt?.connected) {
        device.gatt.disconnect();
      }
    } catch {
      // ignore
    }
  }

  private cacheBluetoothDevice(device: any): BleOtaDeviceItem {
    const item: BleOtaDeviceItem = {
      id: device.id,
      name: device.name || 'BLE OTA Device',
      device,
      connected: !!device.gatt?.connected,
      source: 'web-bluetooth',
    };
    try {
      device.removeEventListener?.('gattserverdisconnected', this.handleGattDisconnected);
      device.addEventListener?.('gattserverdisconnected', this.handleGattDisconnected);
    } catch {
      // ignore
    }
    this.knownDevices.set(item.id, item);
    this.removeDiscoveredDuplicates(item);
    this.emitDevices(this.isScanning());
    return item;
  }

  private removeDiscoveredDuplicates(deviceItem: BleOtaDeviceItem, deviceId?: string, deviceName?: string): void {
    if (deviceId) {
      this.discoveredDevices.delete(deviceId);
    }

    const dedupKeys = new Set([
      this.getDeviceDedupKey(deviceItem),
      this.getDeviceDedupKey({ ...deviceItem, name: deviceName || deviceItem.name }),
    ].filter(Boolean));

    for (const [id, discovered] of this.discoveredDevices) {
      if (id === deviceItem.id || dedupKeys.has(this.getDeviceDedupKey(discovered))) {
        this.discoveredDevices.delete(id);
      }
    }
  }

  private getDeviceDedupKey(device?: Pick<BleOtaDeviceItem, 'id' | 'name'>): string {
    return (device?.name || '').trim().toLowerCase() || (device?.id || '').trim().toLowerCase();
  }

  private releaseDeviceConnection(deviceItem: BleOtaDeviceItem, reason: string): BleOtaDeviceItem {
    const device = deviceItem?.device;
    const wasConnected = !!device?.gatt?.connected;

    if (!wasConnected) {
      if (deviceItem.connected) {
        const updated = { ...deviceItem, connected: false };
        this.knownDevices.set(deviceItem.id, updated);
        return updated;
      }
      return deviceItem;
    }

    try {
      this.debug('disconnect BLE device after selection', {
        reason,
        id: deviceItem.id,
        name: deviceItem.name,
      });
      device.gatt.disconnect();
    } catch (error) {
      console.warn('断开 BLE 设备连接失败:', error);
    }

    this.server = null;
    this.recvFwCharacteristic = null;
    this.commandCharacteristic = null;
    this.rejectPendingAcks(new Error('BLE 连接已关闭'));
    const updated = { ...deviceItem, connected: false };
    this.knownDevices.set(deviceItem.id, updated);
    this.emitDevices(this.isScanning());
    return updated;
  }

  private cacheDiscoveredDevice(rawDevice: any): void {
    const id = rawDevice.deviceId || rawDevice.id;
    if (!id) return;
    this.discoveredDevices.set(id, {
      id,
      name: rawDevice.deviceName || rawDevice.name || 'BLE OTA Device',
      source: 'electron-scan',
    });
  }

  private setupElectronBluetoothBridge(): void {
    if (this.bridgeInitialized) return;
    this.bridgeInitialized = true;

    if (!window['ble']?.onDeviceList) {
      this.debug('electron BLE bridge missing');
      return;
    }

    this.debug('register electron BLE device list listener');

    this.removeBridgeDeviceListListener = window['ble'].onDeviceList((devices: any[]) => {
      if (!this.searching) return;

      this.debug('device list received from electron', {
        count: Array.isArray(devices) ? devices.length : -1,
        devices,
      });
      this.discoveredDevices.clear();
      for (const device of devices || []) {
        this.cacheDiscoveredDevice(device);
      }
      this.emitDevices(true);
    });
  }

  private startSearchWindow(timeoutMs: number): void {
    this.clearSearchTimeout();
    this.searching = true;
    window['ble']?.startDeviceListUpdates?.().catch?.(() => undefined);
    this.emitDevices(true);

    this.scanTimeoutTimer = setTimeout(() => {
      this.searching = false;
      window['ble']?.stopDeviceListUpdates?.().catch?.(() => undefined);
      this.debug('scan timeout reached', {
        timeoutMs,
        discoveredCount: this.discoveredDevices.size,
      });
      this.emitDevices(false);
    }, Math.max(0, timeoutMs));
  }

  private clearSearchTimeout(): void {
    if (this.scanTimeoutTimer) {
      clearTimeout(this.scanTimeoutTimer);
      this.scanTimeoutTimer = null;
    }
  }

  private emitDevices(scanning: boolean): void {
    const devices = this.getDevices();
    if (!this.emitLogTimer) {
      this.emitLogTimer = setTimeout(() => {
        this.emitLogTimer = null;
        this.debug('emit devices', {
          scanning,
          count: devices.length,
          devices: devices.map(device => ({ id: device.id, name: device.name, source: device.source }))
        });
      }, 0);
    }
    this.devicesChanged.next(devices);
    this.scanStateChanged.next({ scanning, devices });
  }

  private debug(message: string, data?: any): void {
    if (data !== undefined) {
      console.log('[BLE:web]', message, data);
    } else {
      console.log('[BLE:web]', message);
    }
  }

  private rejectPendingAcks(error: any): void {
    for (const pending of this.pendingCommandAcks) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    for (const pending of this.pendingSectorAcks) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingCommandAcks = [];
    this.pendingSectorAcks = [];
  }

  private throwIfCancelled(signal?: AbortSignal): void {
    if (this.cancelRequested || signal?.aborted) {
      throw new Error('上传已取消');
    }
  }

  private getBluetooth(): any {
    return navigator?.['bluetooth'];
  }

  private isElectronRuntime(): boolean {
    return !!window['ipcRenderer'] || navigator.userAgent.toLowerCase().includes(' electron/');
  }

  private isSelectedGattConnected(): boolean {
    return !!this.getSelectedDevice()?.device?.gatt?.connected;
  }

  private isCommandAckTimeout(error: any, commandId: number): boolean {
    const message = error?.message || String(error || '');
    return message.includes(`等待命令 ACK 超时: 0x${commandId.toString(16)}`);
  }

  private isDisconnectedError(error: any): boolean {
    const message = error?.message || String(error || '');
    return /BLE 设备已断开|GATT Server is disconnected|device is disconnected|disconnected/i.test(message);
  }

  private isTransientConnectionError(error: any): boolean {
    const message = error?.message || String(error || '');
    return /Connection Error|Connection attempt failed|GATT operation failed|GATT Server is disconnected|NetworkError|Bluetooth device is no longer in range/i.test(message);
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private getEventBytes(event: any): Uint8Array {
    const value = event?.target?.value;
    if (!value) return new Uint8Array();
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }

  private isFrameCrcValid(data: Uint8Array): boolean {
    if (data.byteLength < 4) return false;
    const expected = this.readUint16LE(data, data.byteLength - 2);
    return this.crc16(data.subarray(0, data.byteLength - 2)) === expected;
  }

  private crc16(data: Uint8Array): number {
    let crc = 0x0000;
    for (const byte of data) {
      crc ^= byte << 8;
      for (let bit = 0; bit < 8; bit++) {
        crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
        crc &= 0xffff;
      }
    }
    return crc & 0xffff;
  }

  private readUint16LE(data: Uint8Array, offset: number): number {
    return data[offset] | (data[offset + 1] << 8);
  }

  private writeUint16LE(data: Uint8Array, offset: number, value: number): void {
    data[offset] = value & 0xff;
    data[offset + 1] = (value >> 8) & 0xff;
  }

  private writeUint32LE(data: Uint8Array, offset: number, value: number): void {
    data[offset] = value & 0xff;
    data[offset + 1] = (value >> 8) & 0xff;
    data[offset + 2] = (value >> 16) & 0xff;
    data[offset + 3] = (value >> 24) & 0xff;
  }

  private formatAckError(status: number, commandId?: number): string {
    const prefix = typeof commandId === 'number' ? `命令 0x${commandId.toString(16)} ` : '';
    switch (status) {
      case ACK_CRC_ERROR:
        return `${prefix}CRC 错误或写入失败`;
      case ACK_INDEX_ERROR:
        return `${prefix}Sector 序号错误`;
      case ACK_SIGNATURE_ERROR:
        return `${prefix}签名校验失败或负载长度错误`;
      case ACK_START_ERROR:
        return `${prefix}无法启动 OTA，可能分区空间不足或设备正忙`;
      default:
        return `${prefix}返回未知状态: 0x${status.toString(16)}`;
    }
  }

  private collectFiles(dirPath: string, result: string[] = []): string[] {
    const entries = window['fs'].readDirSync(dirPath) || [];
    for (const entry of entries) {
      const name = entry.name || entry;
      const filePath = window['path'].join(dirPath, name);
      const isDirectory = entry._isDirectory ?? window['fs'].statSync(filePath)._isDirectory;
      const isFile = entry._isFile ?? window['fs'].statSync(filePath)._isFile;
      if (isDirectory) {
        this.collectFiles(filePath, result);
      } else if (isFile) {
        result.push(filePath);
      }
    }
    return result;
  }

  private base64ToBytes(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }
}