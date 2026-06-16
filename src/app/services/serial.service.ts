import { Injectable } from '@angular/core';
import { ElectronService } from './electron.service';

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

  // 编译上传时，通过这里获取串口
  currentPort: any = null;

  // 保存浏览器环境中的 SerialPort 映射
  browserPortsMap = new Map<string, any>();

  constructor(
    private electronService: ElectronService
  ) { }

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
        let name = '';
        for (const [k, v] of this.browserPortsMap.entries()) {
          if (v === port) {
            name = k;
            break;
          }
        }
        if (!name) {
          name = `串口 ${this.browserPortsMap.size + 1}`;
          this.browserPortsMap.set(name, port);
        }
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
        const ports = await navigator['serial'].getPorts();
        const serialList: PortItem[] = ports.map((port, index) => {
          const name = `串口 ${index + 1}`;
          this.browserPortsMap.set(name, port);
          return {
            port: port,
            name: name,
            text: `已授权设备 ${index + 1}`,
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
}

export interface PortItem {
  port?: any,  // SerialPort 对象（浏览器环境）或字符串（Electron 环境）
  name?: string,
  text?: string,
  type?: string,
  icon?: string,
  disabled?: boolean
}

