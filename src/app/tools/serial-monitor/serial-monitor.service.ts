import { Injectable } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';
import { Buffer } from 'buffer';
import { SerialService } from '../../services/serial.service';
import { NzMessageService } from 'ng-zorro-antd/message';
import { ConfigService } from '../../services/config.service';

@Injectable({
  providedIn: 'root'
})
export class SerialMonitorService {
  // 数据列表最大条数，超过时裁剪旧数据以节省内存
  private static readonly MAX_DATA_SIZE = 100000;
  // 裁剪后保留的条数（批量裁剪，避免频繁操作）
  private static readonly TRIM_TARGET_SIZE = 90000;

  viewMode = {
    showHex: false, // hex显示
    showCtrlChar: false, // 控制字符显示
    autoWrap: true, // 换行显示
    autoScroll: true, // 自动滚动显示
    showTimestamp: true, // 时间显示
  }

  inputMode = {
    hexMode: false,
    sendByEnter: false,
    endR: true,
    endN: true,
  }

  dataList: dataItem[] = [];

  dataUpdated = new Subject<void | dataItem>();

  // 串口相关属性
  private serialPort: any = null;
  private lastDataTime = 0;
  private firstDataTime = 0; // 当前记录首次接收数据的时间
  private isConnected = false;

  // 数据更新节流控制：高频数据流下最多 ~20次/秒 通知UI
  private static readonly UPDATE_THROTTLE_MS = 50;
  private updateThrottleTimer: any = null;

  // Buffer 分块累积：避免高频 Buffer.concat，追加数据时只 push 到数组
  // 仅在 UI 通知前或创建新记录时才合并
  private pendingChunks: Buffer[] = [];
  private pendingItem: dataItem | null = null;

  // 状态观察对象
  connectionStatus = new BehaviorSubject<boolean>(false);
  availablePorts = new BehaviorSubject<any[]>([]);

  sendHistoryList = [];

  quickSendList: QuickSendItem[] = []

  constructor(
    private serialService: SerialService,
    private message: NzMessageService,
    private configService: ConfigService
  ) {
    this.loadQuickSendList();
  }

  /**
   * 获取可用串口列表
   */
  async getPortsList(): Promise<any[]> {
    const ports = await this.serialService.getSerialPorts();
    this.availablePorts.next(ports);
    return ports;
  }

  /**
   * 连接到指定串口
   * @param options 串口配置选项 {path, baudRate, ...}
   */
  async connect(options: any): Promise<boolean> {
    if (this.isConnected) {
      await this.disconnect();
    }

    try {
      this.serialPort = this.serialService.getBrowserPort(options.path);
      if (!this.serialPort) {
        throw new Error('未找到已授权串口');
      }
      await this.serialPort.open({
        baudRate: options.baudRate || 9600,
        dataBits: options.dataBits || 8,
        stopBits: options.stopBits || 1,
        parity: options.parity || 'none',
        flowControl: options.flowControl || 'none',
      });
      this.isConnected = true;
      this.connectionStatus.next(true);
      void this.readLoop();
      this.dataList.push({
        time: new Date().toLocaleTimeString(),
        data: Buffer.from(`[串口已连接: ${options.path} ${options.baudRate}波特]`),
        dir: 'SYS',
        isError: false
      });
      this.dataUpdated.next();
      return true;
    } catch (error) {
      console.error('连接串口失败:', error);
      this.message.error(`连接串口失败: ${error.message || error}`);
      this.isConnected = false;
      this.connectionStatus.next(false);
      return false;
    }
  }

  /**
   * 设置数据监听器
   */
  private async readLoop(): Promise<void> {
    while (this.isConnected && this.serialPort?.readable) {
      const reader = this.serialPort.readable.getReader();
      try {
        while (this.isConnected) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) this.processReceivedData(Buffer.from(value));
        }
      } finally {
        reader.releaseLock();
      }
    }
  }

  /**
   * 处理接收到的数据
   * 根据时间间隔规则存储数据：
   * 1. 如果距离上次数据超过1秒，创建新记录
   * 2. 如果距离首次接收数据超过10秒，创建新记录
   * 3. 其他情况追加到当前记录
   */
  private processReceivedData(data) {
    const currentTime = Date.now();
    const timeString = new Date().toLocaleTimeString();

    // 检查是否需要创建新的数据项
    if (this.dataList.length === 0 ||
      currentTime - this.lastDataTime > 1000 ||
      currentTime - this.firstDataTime > 10000 ||
      this.dataList[this.dataList.length - 1].dir !== 'RX') {
      // 先合并上一条记录的待处理分块
      this.flushPendingChunks();
      // 创建新的数据项
      let item: dataItem = {
        time: timeString,
        data: data,
        dir: 'RX',
        isError: false
      }
      this.dataList.push(item);
      this.pendingItem = item;
      this.pendingChunks = [data];
      // 记录这是新记录的首次接收时间
      this.firstDataTime = currentTime;
    } else {
      // 将数据块追加到待处理列表，O(1) 避免高频 Buffer.concat
      this.pendingChunks.push(data);
    }

    // 更新最后一次接收数据的时间
    this.lastDataTime = currentTime;

    // 检查数据量是否超过上限
    this.trimDataListIfNeeded();

    // 节流通知UI更新，避免高频数据导致过多变更检测
    this.scheduleUpdate();
  }

  /**
   * 前沿+尾沿节流调度UI通知：
   * - 首次数据到达立即通知（前沿，保证实时性）
   * - 节流窗口内压制后续事件
   * - 窗口结束时再通知一次（尾沿，显示期间累积的数据）
   */
  private scheduleUpdate() {
    if (this.updateThrottleTimer === null) {
      // 前沿：立即刷新并通知 UI
      this.flushPendingChunks();
      this.dataUpdated.next();
      // 设置节流窗口，窗口结束时再刷新一次
      this.updateThrottleTimer = setTimeout(() => {
        this.updateThrottleTimer = null;
        this.flushPendingChunks();
        this.dataUpdated.next();
      }, SerialMonitorService.UPDATE_THROTTLE_MS);
    }
  }

  /**
   * 将累积的数据分块合并到当前记录（延迟合并策略）
   * 高频数据流下每次追加只做 O(1) 的 push，
   * 仅在 UI 通知前或新建记录时才执行一次 Buffer.concat
   */
  private flushPendingChunks() {
    if (!this.pendingItem || this.pendingChunks.length === 0) return;
    if (this.pendingChunks.length > 1) {
      const combined = Buffer.concat(this.pendingChunks);
      this.pendingItem.data = combined;
      // 重置为单个已合并的 Buffer，避免下次重复 concat 旧数据
      this.pendingChunks = [combined];
    }
    // 更新 isError 标志（仅在未标记时检查，避免重复扫描）
    if (!this.pendingItem.isError && Buffer.isBuffer(this.pendingItem.data)) {
      this.pendingItem.isError = this.pendingItem.data.includes('error:');
    }
  }

  /**
   * 当数据条数超过上限时，丢弃最前面的旧数据
   */
  private trimDataListIfNeeded() {
    if (this.dataList.length > SerialMonitorService.MAX_DATA_SIZE) {
      const removeCount = this.dataList.length - SerialMonitorService.TRIM_TARGET_SIZE;
      this.dataList = this.dataList.slice(removeCount);
    }
  }

  /**
   * 发送数据到串口
   */
  sendData(data: string, mode = 'text', IgnoreEnd = false): Promise<boolean> {
    if (!this.isConnected || !this.serialPort) {
      this.message.warning('串口未连接，请先打开串口');
      return Promise.resolve(false);
    }
    return new Promise(async (resolve) => {
      let bufferToSend;
      if (typeof data === 'string') {
        // 如果输入模式是hex，则将字符串解析为hex
        if (this.inputMode.hexMode || mode === 'hex') {
          // 移除空格和非hex字符
          const hexString = data.replace(/[^0-9A-Fa-f]/g, '');
          // 确保有偶数个字符
          const paddedHex = hexString.length % 2 ? '0' + hexString : hexString;
          // 转换为Buffer
          bufferToSend = Buffer.from(paddedHex, 'hex');
        } else {
          // 普通字符串
          let textToSend = data;
          // 如果设置了enter选项，添加换行符
          if (!IgnoreEnd) {
            if (this.inputMode.endR) {
              textToSend += '\r';
            }
            if (this.inputMode.endN) {
              textToSend += '\n';
            }
          }
          bufferToSend = Buffer.from(textToSend);
        }
      } else {
        // 已经是Buffer
        bufferToSend = data;
      }

      try {
        const writer = this.serialPort.writable.getWriter();
        await writer.write(bufferToSend);
        writer.releaseLock();
        this.dataList.push({
          time: new Date().toLocaleTimeString(),
          data: bufferToSend,
          dir: 'TX',
          isError: false
        });
        this.dataUpdated.next();
        resolve(true);
      } catch (error) {
        console.error('发送数据失败:', error);
        resolve(false);
      }
    });
  }

  /**
   * 断开串口连接
   */
  async disconnect(): Promise<boolean> {
    // 合并剩余的待处理数据分块
    this.flushPendingChunks();
    this.pendingItem = null;
    this.pendingChunks = [];

    if (!this.isConnected || !this.serialPort) {
      return true;
    }

    try {
      this.isConnected = false;
      await this.serialPort.close();
      this.connectionStatus.next(false);
      this.serialPort = null;
      return true;
    } catch (error) {
      console.error('关闭串口失败:', error);
      this.message.error(`关闭串口失败: ${error?.message || error}`);
      return false;
    }
  }

  /**
   * 清除数据列表
   */
  clearData() {
    this.dataList = [];
    this.pendingItem = null;
    this.pendingChunks = [];
  }

  /**
   * 检查是否已连接
   */
  isPortConnected(): boolean {
    return this.isConnected;
  }


  async exportData() {
    if (this.dataList.length === 0) {
      console.warn('没有数据可以导出');
      return;
    }

    // 准备要写入的内容
    let fileContent = '';

    // 根据viewMode设置处理每个数据项
    for (const item of this.dataList) {
      // 添加时间戳
      if (this.viewMode.showTimestamp) {
        fileContent += `[${item.time}] `;
        fileContent += item.dir;
      }

      // 处理数据内容
      let dataContent = '';
      if (this.viewMode.showHex) {
        // 转换为Hex显示
        if (Buffer.isBuffer(item.data)) {
          dataContent = Array.from(item.data)
            .map(byte => byte.toString(16).padStart(2, '0'))
            .join(' ');
        } else {
          dataContent = Buffer.from(String(item.data)).toString('hex');
        }
      } else {
        // 文本模式
        let textData = '';
        if (Buffer.isBuffer(item.data)) {
          textData = item.data.toString();
        } else {
          textData = String(item.data);
        }

        // 控制字符处理
        if (this.viewMode.showCtrlChar) {
          // 替换常见控制字符为可见符号
          dataContent = textData
            .replace(/\r\n/g, '\\r\\n\n')
            .replace(/\n/g, '\\n\n')
            .replace(/\r/g, '\\r\n')
            .replace(/\t/g, '\\t')
            .replace(/\f/g, '\\f')
            .replace(/\v/g, '\\v')
            .replace(/\0/g, '\\0');
        } else {
          dataContent = textData;
        }
      }

      // 添加数据内容
      fileContent += dataContent;

      // 如果不是自动换行模式且是最后一个数据项，不添加额外换行
      if (this.viewMode.autoWrap || fileContent.endsWith('\n')) {
        // 已经有换行了
      } else {
        fileContent += '\n';
      }
    }

    const fileName = 'serial_' + new Date().toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    }).replace(/[/,:]/g, '_').replace(/\s/g, '_') + '.txt';
    const url = URL.createObjectURL(new Blob([fileContent], { type: 'text/plain;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    URL.revokeObjectURL(url);
    this.message.success('串口数据已导出');
  }

  /**
   * 发送控制信号(DTR/RTS)到串口
   * @param signalType 信号类型: 'DTR' 或 'RTS'
   * @param state 信号状态: true为设置，false为清除，不传则切换当前状态
   * @returns 操作是否成功
   */
  sendSignal(signalType: 'DTR' | 'RTS', state?: boolean): Promise<boolean> {
    if (!this.isConnected || !this.serialPort) {
      this.message.warning('串口未连接，请先打开串口');
      return Promise.resolve(false);
    }

    const enabled = state ?? true;
    const signals = signalType === 'DTR'
      ? { dataTerminalReady: enabled }
      : { requestToSend: enabled };
    return this.serialPort.setSignals(signals).then(() => {
      this.dataList.push({
        time: new Date().toLocaleTimeString(),
        data: Buffer.from(`[设置${signalType}信号: ${enabled ? '开启' : '关闭'}]`),
        dir: 'SYS',
        isError: false
      });
      this.dataUpdated.next();
      return true;
    }).catch((error: unknown) => {
      console.error(`设置${signalType}信号失败:`, error);
      this.message.error(`设置${signalType}信号失败`);
      return false;
    });
  }

  saveQuickSendList() {
    // 保存到ConfigService中
    this.configService.data.quickSendList = this.quickSendList;
    this.configService.save();
  }

  loadQuickSendList() {
    // 从ConfigService中加载
    if (this.configService.data?.quickSendList) {
      try {
        this.quickSendList = this.configService.data.quickSendList;
      } catch (e) {
        console.error('解析快速发送列表失败:', e);
      }
    } else {
      // 如果没有数据，则使用默认值
      this.quickSendList = [
        { name: 'DTR', type: 'signal', data: 'DTR' },
        { name: 'RTS', type: 'signal', data: 'RTS' },
        { name: '发送文本', type: 'text', data: 'This is Cycore MCU DevCloud' },
        { name: '发送Hex', type: 'hex', data: 'FF FF A1 A2 A3 A4 A5' }
      ];
    }
  }
}

export interface dataItem {
  time: string,
  data: any,
  dir: 'TX' | 'RX' | 'SYS',
  isError?: boolean,
  searchHighlight?: boolean,
  showHex?: boolean,
  highlight?: boolean,
}

export interface QuickSendItem {
  "name": string,
  "type": "signal" | "text" | "hex",
  "data": string
}
