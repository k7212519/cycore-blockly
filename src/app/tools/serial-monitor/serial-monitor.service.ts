import { Injectable, NgZone } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';
import { Buffer } from 'buffer';
import { SerialService } from '../../services/serial.service';
import { NzMessageService } from 'ng-zorro-antd/message';
import { ConfigService } from '../../services/config.service';

@Injectable({
  providedIn: 'root'
})
export class SerialMonitorService {
  // Web Serial 默认缓冲区很小。适当放大缓冲区可减少高波特率下的 read() 回调数量。
  private static readonly SERIAL_BUFFER_SIZE = 64 * 1024;
  // 单条记录保持有界，避免一个虚拟列表项内部包含过多文本或 DOM 节点。
  private static readonly MAX_ITEM_BYTES = 32 * 1024;
  // 同时按条数和字节数限制历史数据，防止少量超大记录绕过条数限制。
  private static readonly MAX_DATA_SIZE = 10000;
  private static readonly TRIM_TARGET_SIZE = 8000;
  private static readonly MAX_DATA_BYTES = 8 * 1024 * 1024;
  private static readonly TRIM_TARGET_BYTES = 6 * 1024 * 1024;

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
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private readLoopTask: Promise<void> | null = null;
  private writeTask: Promise<void> | null = null;
  private lastDataTime = 0;
  private firstDataTime = 0; // 当前记录首次接收数据的时间
  private isConnected = false;

  // 串口监视器不需要逐块刷新；10fps 足以保持实时感，并显著减少渲染和滚动次数。
  private static readonly UPDATE_INTERVAL_MS = 100;
  private updateTimer: ReturnType<typeof setTimeout> | null = null;

  // Buffer 分块累积：避免高频 Buffer.concat，追加数据时只 push 到数组
  // 仅在 UI 通知前或创建新记录时才合并
  private pendingChunks: Uint8Array[] = [];
  private pendingBytes = 0;
  private pendingItem: dataItem | null = null;
  private pendingErrorTail = Buffer.alloc(0);
  private totalDataBytes = 0;

  // 状态观察对象
  connectionStatus = new BehaviorSubject<boolean>(false);
  availablePorts = new BehaviorSubject<any[]>([]);

  sendHistoryList = [];

  quickSendList: QuickSendItem[] = []

  constructor(
    private serialService: SerialService,
    private message: NzMessageService,
    private configService: ConfigService,
    private ngZone: NgZone
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
        bufferSize: SerialMonitorService.SERIAL_BUFFER_SIZE,
      });
      this.isConnected = true;
      this.connectionStatus.next(true);
      // reader.read() 的完成频率由浏览器和驱动决定。整个读取循环放在 Zone 外，
      // 避免 Windows 上小数据块导致每次 read() 都触发 Angular 全局变更检测。
      this.readLoopTask = this.ngZone.runOutsideAngular(() => this.readLoop());
      this.appendDataItem({
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
      this.reader = reader;
      try {
        while (this.isConnected) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value?.byteLength) this.processReceivedData(value);
        }
      } catch (error) {
        if (this.isConnected) {
          console.error('读取串口数据失败:', error);
        }
      } finally {
        if (this.reader === reader) {
          this.reader = null;
        }
        try {
          reader.releaseLock();
        } catch {
          // ignore release errors while the browser is tearing down the stream
        }
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
  private processReceivedData(data: Uint8Array) {
    const currentTime = Date.now();
    const timeString = new Date().toLocaleTimeString();

    // Web Serial 的 chunk 边界是任意的。将大 chunk 拆入有界记录，
    // 同时只保存对浏览器返回 Uint8Array 的引用，等 UI 批量刷新时再合并一次。
    let offset = 0;
    while (offset < data.byteLength) {
      if (this.shouldStartNewItem(currentTime)) {
        this.startRxItem(timeString, currentTime);
      }

      const committedBytes = this.pendingItem?.data?.length || 0;
      const availableBytes = SerialMonitorService.MAX_ITEM_BYTES - committedBytes - this.pendingBytes;
      if (availableBytes <= 0) {
        this.flushPendingChunks();
        this.pendingItem = null;
        continue;
      }

      const chunkSize = Math.min(availableBytes, data.byteLength - offset);
      const chunk = data.subarray(offset, offset + chunkSize);
      this.pendingChunks.push(chunk);
      this.pendingBytes += chunkSize;
      this.totalDataBytes += chunkSize;
      offset += chunkSize;

      if (committedBytes + this.pendingBytes >= SerialMonitorService.MAX_ITEM_BYTES) {
        this.flushPendingChunks();
        this.pendingItem = null;
      }
    }

    // 更新最后一次接收数据的时间
    this.lastDataTime = currentTime;

    // 检查数据量是否超过上限
    this.trimDataListIfNeeded();

    // 节流通知UI更新，避免高频数据导致过多变更检测
    this.scheduleUpdate();
  }

  private shouldStartNewItem(currentTime: number): boolean {
    return !this.pendingItem
      || this.dataList.length === 0
      || currentTime - this.lastDataTime > 1000
      || currentTime - this.firstDataTime > 10000
      || this.dataList[this.dataList.length - 1].dir !== 'RX';
  }

  private startRxItem(time: string, currentTime: number): void {
    this.flushPendingChunks();
    const item: dataItem = {
      time,
      data: Buffer.alloc(0),
      dir: 'RX',
      isError: false
    };
    this.dataList.push(item);
    this.pendingItem = item;
    this.pendingChunks = [];
    this.pendingBytes = 0;
    this.pendingErrorTail = Buffer.alloc(0);
    this.firstDataTime = currentTime;
  }

  /**
   * 尾沿批量通知 UI。同一个时间窗口只合并、渲染和滚动一次，
   * 避免前沿+尾沿在窗口边界产生相邻的两次刷新。
   */
  private scheduleUpdate() {
    if (this.updateTimer === null) {
      this.updateTimer = setTimeout(() => {
        this.updateTimer = null;
        this.flushPendingChunks();
        this.dataUpdated.next();
      }, SerialMonitorService.UPDATE_INTERVAL_MS);
    }
  }

  /**
   * 将累积的数据分块合并到当前记录（延迟合并策略）
   * 高频数据流下每次追加只做 O(1) 的 push，
   * 仅在 UI 通知前或新建记录时才执行一次 Buffer.concat
   */
  private flushPendingChunks() {
    if (!this.pendingItem || this.pendingChunks.length === 0) return;

    const appendedData = Buffer.concat(this.pendingChunks, this.pendingBytes);
    const existingData = Buffer.isBuffer(this.pendingItem.data)
      ? this.pendingItem.data
      : Buffer.from(this.pendingItem.data || '');
    this.pendingItem.data = existingData.length === 0
      ? appendedData
      : Buffer.concat([existingData, appendedData], existingData.length + appendedData.length);

    // 只检查新增数据，并保留关键字长度以内的边界，避免反复扫描整条历史记录。
    if (!this.pendingItem.isError) {
      const errorProbe = this.pendingErrorTail.length > 0
        ? Buffer.concat([this.pendingErrorTail, appendedData])
        : appendedData;
      this.pendingItem.isError = errorProbe.includes('error:');
      this.pendingErrorTail = errorProbe.subarray(Math.max(0, errorProbe.length - 5));
    }

    this.pendingChunks = [];
    this.pendingBytes = 0;
  }

  /**
   * 当数据条数超过上限时，丢弃最前面的旧数据
   */
  private trimDataListIfNeeded() {
    if (this.dataList.length <= SerialMonitorService.MAX_DATA_SIZE
      && this.totalDataBytes <= SerialMonitorService.MAX_DATA_BYTES) return;

    let removeCount = 0;
    let remainingBytes = this.totalDataBytes;
    const maxRemovable = Math.max(0, this.dataList.length - 1);
    while (removeCount < maxRemovable
      && (this.dataList.length - removeCount > SerialMonitorService.TRIM_TARGET_SIZE
        || remainingBytes > SerialMonitorService.TRIM_TARGET_BYTES)) {
      remainingBytes -= this.getDataByteLength(this.dataList[removeCount].data);
      removeCount++;
    }

    if (removeCount > 0) {
      this.dataList = this.dataList.slice(removeCount);
      this.totalDataBytes = Math.max(0, remainingBytes);
    }
  }

  private appendDataItem(item: dataItem): void {
    // TX/SYS 记录可能插入正在批量累积的 RX 记录之后；先提交 RX，
    // 保证本次 dataUpdated 通知不会让图表或日志漏掉尚未合并的数据。
    if (item.dir !== 'RX') {
      this.flushPendingChunks();
    }
    this.dataList.push(item);
    this.totalDataBytes += this.getDataByteLength(item.data);
    this.trimDataListIfNeeded();
  }

  private getDataByteLength(data: unknown): number {
    if (typeof data === 'string') return Buffer.byteLength(data);
    if (data instanceof Uint8Array) return data.byteLength;
    return Buffer.byteLength(String(data ?? ''));
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
        this.writer = this.serialPort.writable.getWriter();
        this.writeTask = this.writer.write(bufferToSend);
        await this.writeTask;
        this.appendDataItem({
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
      } finally {
        if (this.writer) {
          try {
            this.writer.releaseLock();
          } catch {
            // ignore release errors while the browser is tearing down the stream
          }
          this.writer = null;
        }
        this.writeTask = null;
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
    this.pendingBytes = 0;
    this.pendingErrorTail = Buffer.alloc(0);

    if (!this.isConnected || !this.serialPort) {
      return true;
    }

    try {
      this.isConnected = false;
      this.connectionStatus.next(false);

      if (this.reader) {
        try {
          await this.reader.cancel();
        } catch (error) {
          if (!this.isExpectedSerialCloseError(error)) {
            console.warn('取消串口读取失败:', error);
          }
        }
      }

      if (this.readLoopTask) {
        try {
          await this.readLoopTask;
        } catch (error) {
          if (!this.isExpectedSerialCloseError(error)) {
            console.warn('等待串口读取循环结束失败:', error);
          }
        } finally {
          this.readLoopTask = null;
        }
      }

      if (this.writer) {
        if (this.writeTask) {
          try {
            await this.writeTask;
          } catch (error) {
            if (!this.isExpectedSerialCloseError(error)) {
              console.warn('等待串口写入结束失败:', error);
            }
          } finally {
            this.writeTask = null;
          }
        }
        try {
          this.writer.releaseLock();
        } catch {
          // ignore release errors while the browser is tearing down the stream
        }
        this.writer = null;
      }

      await this.serialPort.close();
      this.serialPort = null;
      return true;
    } catch (error) {
      if (this.isExpectedSerialCloseError(error)) {
        this.serialPort = null;
        return true;
      }
      console.error('关闭串口失败:', error);
      this.message.error(`关闭串口失败: ${error?.message || error}`);
      return false;
    }
  }

  private isExpectedSerialCloseError(error: unknown): boolean {
    const name = (error as any)?.name || '';
    const message = String((error as any)?.message || error || '');
    return name === 'NetworkError'
      || message.includes('The device has been lost')
      || message.includes('device has been lost');
  }

  /**
   * 清除数据列表
   */
  clearData() {
    this.dataList = [];
    this.pendingItem = null;
    this.pendingChunks = [];
    this.pendingBytes = 0;
    this.pendingErrorTail = Buffer.alloc(0);
    this.totalDataBytes = 0;
    if (this.updateTimer !== null) {
      clearTimeout(this.updateTimer);
      this.updateTimer = null;
    }
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
      this.appendDataItem({
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
