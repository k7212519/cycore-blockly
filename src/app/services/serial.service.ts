import { Injectable } from '@angular/core';
import { ElectronService } from './electron.service';
import { Subject } from 'rxjs';

// export const BOARD_NAME: Record<string, string> = {
//   'VID_303A&PID_1001': 'XIAO ESP32S3'
// };

// export function getBoardNameByVidPid(vendorId: string | undefined, productId: string | undefined): string | undefined {
//   if (!vendorId || !productId) return undefined;
//   const key = `VID_${vendorId.toUpperCase()}&PID_${productId.toUpperCase()}`;
//   return BOARD_NAME[key];
// }

@Injectable({
  providedIn: 'root'
})
export class SerialService {

  private _currentPort: any = null;

  // 编译上传时，通过这里获取串口
  get currentPort(): any {
    return this._currentPort;
  }

  set currentPort(port: any) {
    this._currentPort = port;
    this.rememberSelectedBrowserPort(port);
    this.portChangedSubject.next();
  }

  // 保存浏览器环境中的 SerialPort 映射
  browserPortsMap = new Map<string, any>();
  private disconnectedBrowserPorts = new WeakSet<any>();
  private browserSerialEventsInitialized = false;
  private lastSelectedBrowserPort: any = null;
  private lastSelectedBrowserPortName = '';
  private lastSelectedBrowserPortInfo = '';
  private portChangedSubject = new Subject<void>();
  portsChanged$ = this.portChangedSubject.asObservable();

  constructor(
    private electronService: ElectronService
  ) {
    this.ensureBrowserSerialEvents();
  }

  getBrowserPort(name: string): any {
    return this.browserPortsMap.get(name);
  }

  // 请求新的串口权限
  async requestPort(): Promise<any> {
    try {
      if (!navigator['serial']) {
        console.error('您的浏览器不支持 Web Serial API');
        return null;
      }
      const port = await navigator['serial'].requestPort();
      if (port) {
        this.disconnectedBrowserPorts.delete(port);
        const name = this.registerBrowserPort(port);
        this.currentPort = name;
        return port;
      }
      return null;
    } catch (error) {
      console.error('请求 Web Serial 串口失败:', error);
      return null;
    }
  }

  // 此处还未考虑linux、macos适配
  async getSerialPorts(): Promise<PortItem[]> {
    if (this.electronService.isElectron) {
      const currentSerialPortList = await window['SerialPort'].list();

      // console.log("Detected serial ports: ", currentSerialPortList);

      let serialList: PortItem[] = [];

      if (window['platform'].isWindows) {
        serialList = currentSerialPortList.map((item) => {
          let friendlyName: string = (item.friendlyName || item.manufacturer || item.path || '').replace(/ \(COM\d+\)$/, '');
          let keywords = ["蓝牙", "ble", "bluetooth"];
          let icon: string = keywords.some(keyword => (item.friendlyName || '').toLowerCase().includes(keyword.toLowerCase())) ? "fa-light fa-bluetooth" : 'fa-light fa-usb-drive';
          return {
            name: item.path,
            text: friendlyName,
            type: 'serial',
            icon: icon,
          }
        });
      } else if (window['platform'].isMacOS) {
        // 只返回usb串口设备
        serialList = currentSerialPortList.map((item) => {
          // 将 tty 路径转换为 cu 路径
          let devicePath = item.path.replace('/dev/tty.', '/dev/cu.');
          
          let friendlyName: string = item.manufacturer? item.manufacturer : devicePath.replace('/dev/cu.usbserial-', '').replace('/dev/cu.', '');
          let keywords = ["usb", "serial", "uart", "ftdi", "ch340", "cp210x"];
          let icon: string = keywords.some(keyword => devicePath.toLowerCase().includes(keyword.toLowerCase())) ? "fa-light fa-usb-drive" : 'fa-light fa-computer';
          return {
            name: devicePath, // 使用转换后的 cu 路径
            text: friendlyName,
            type: 'serial',
            icon: icon,
          }
        });
      }
      
      return serialList;
    } else {
      try {
        if (!navigator['serial']) {
          return [];
        }
        this.ensureBrowserSerialEvents();
        const ports = await navigator['serial'].getPorts();
        this.removeUnavailableBrowserPorts(ports);
        const serialList: PortItem[] = ports
          .filter(port => !this.disconnectedBrowserPorts.has(port))
          .map((port) => {
            const name = this.registerBrowserPort(port);
            return {
              port: port,
              name: name,
              text: `已授权设备 ${name.replace('串口 ', '')}`,
              type: 'serial',
              icon: 'fa-light fa-usb-drive'
            };
          });
        return serialList;
      } catch (error) {
        console.error('获取 Web Serial 串口失败:', error);
        return [];
      }
    }
  }

  private ensureBrowserSerialEvents(): void {
    if (this.browserSerialEventsInitialized || this.electronService.isElectron) {
      return;
    }
    if (typeof navigator === 'undefined' || !navigator['serial']?.addEventListener) {
      return;
    }

    this.browserSerialEventsInitialized = true;
    navigator['serial'].addEventListener('disconnect', (event: any) => {
      this.handleBrowserPortDisconnect(event?.target);
    });
    navigator['serial'].addEventListener('connect', (event: any) => {
      this.handleBrowserPortConnect(event?.target);
    });
  }

  private handleBrowserPortDisconnect(port: any): void {
    if (!port) {
      return;
    }

    const name = this.findBrowserPortName(port);
    if (name) {
      this.lastSelectedBrowserPort = port;
      this.lastSelectedBrowserPortName = name;
      this.lastSelectedBrowserPortInfo = this.getBrowserPortInfoKey(port);
      this.browserPortsMap.delete(name);
      if (this._currentPort === name) {
        this._currentPort = null;
      }
    }
    this.disconnectedBrowserPorts.add(port);
    this.portChangedSubject.next();
  }

  private handleBrowserPortConnect(port: any): void {
    if (!port) {
      return;
    }

    this.disconnectedBrowserPorts.delete(port);
    const infoKey = this.getBrowserPortInfoKey(port);
    const isLastSelectedPort = port === this.lastSelectedBrowserPort
      || (!!infoKey && infoKey === this.lastSelectedBrowserPortInfo);
    const name = this.registerBrowserPort(
      port,
      isLastSelectedPort ? this.lastSelectedBrowserPortName : ''
    );
    if (isLastSelectedPort) {
      this._currentPort = name;
      this.rememberSelectedBrowserPort(name);
    }
    this.portChangedSubject.next();
  }

  private registerBrowserPort(port: any, preferredName = ''): string {
    const existingName = this.findBrowserPortName(port);
    if (existingName) {
      return existingName;
    }

    let name = preferredName && !this.browserPortsMap.has(preferredName)
      ? preferredName
      : this.allocateBrowserPortName();
    this.browserPortsMap.set(name, port);
    return name;
  }

  private allocateBrowserPortName(): string {
    let index = 1;
    let name = `串口 ${index}`;
    while (this.browserPortsMap.has(name)) {
      index++;
      name = `串口 ${index}`;
    }
    return name;
  }

  private findBrowserPortName(port: any): string {
    for (const [name, currentPort] of this.browserPortsMap.entries()) {
      if (currentPort === port) {
        return name;
      }
    }
    return '';
  }

  private rememberSelectedBrowserPort(portName: any): void {
    if (this.electronService.isElectron || typeof portName !== 'string') {
      return;
    }
    const port = this.browserPortsMap.get(portName);
    if (!port) {
      return;
    }
    this.lastSelectedBrowserPort = port;
    this.lastSelectedBrowserPortName = portName;
    this.lastSelectedBrowserPortInfo = this.getBrowserPortInfoKey(port);
  }

  private getBrowserPortInfoKey(port: any): string {
    try {
      const info = port?.getInfo?.() || {};
      const vendorId = info.usbVendorId ?? '';
      const productId = info.usbProductId ?? '';
      return vendorId || productId ? `${vendorId}:${productId}` : '';
    } catch {
      return '';
    }
  }

  private removeUnavailableBrowserPorts(availablePorts: any[]): void {
    const available = new Set(availablePorts);
    for (const [name, port] of Array.from(this.browserPortsMap.entries())) {
      if (!available.has(port) || this.disconnectedBrowserPorts.has(port)) {
        this.browserPortsMap.delete(name);
        if (this._currentPort === name) {
          this._currentPort = null;
          this.portChangedSubject.next();
        }
      }
    }
  }
}

export interface PortItem {
  port?: any,  // SerialPort 对象（浏览器环境）或字符串（Electron 环境）
  name?: string,
  text?: string,
  type?: string,
  icon?: string,
  disabled?: boolean
}
