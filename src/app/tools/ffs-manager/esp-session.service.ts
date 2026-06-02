import { Injectable } from '@angular/core';
import { ESPLoader, Transport } from 'esptool-js';
import { NodeSerialPortAdapter } from './node-serial-port';

export interface EspSessionConnectOptions {
  portPath: string;
  baudRate: number;
  onLog?: (msg: string) => void;
}

export interface EspChipInfo {
  chipName: string;
  flashSize?: string;
  mac?: string;
  description?: string;
  features?: string[];
  crystalFreq?: number;
}

export type ReadFlashProgress = (received: number, total: number) => void;
export type WriteFlashProgress = (written: number, total: number) => void;

const FLASH_READ_MAX_CHUNK = 0x10000;
const FLASH_READ_MIN_CHUNK = 0x1000;

declare const window: any;

@Injectable({ providedIn: 'root' })
export class EspSessionService {
  private port: NodeSerialPortAdapter | null = null;
  private transport: Transport | null = null;
  private loader: ESPLoader | null = null;
  private chipInfo: EspChipInfo | null = null;
  private currentPortPath: string | null = null;
  private currentBaud: number = 0;
  private operationQueue: Promise<unknown> = Promise.resolve();

  get isConnected(): boolean {
    return Boolean(this.loader && this.transport);
  }

  get chip(): EspChipInfo | null {
    return this.chipInfo;
  }

  get portPath(): string | null {
    return this.currentPortPath;
  }

  get baudRate(): number {
    return this.currentBaud;
  }

  /**
   * 复刻 ESPConnect 的 connectAndHandshake：通过 Node serialport 适配层以 115200 打开端口，
   * 跑 ROM sync 上传 stub，再切到目标波特率。后续读写都复用这条会话。
   */
  async connect(options: EspSessionConnectOptions): Promise<EspChipInfo> {
    if (this.isConnected && this.currentPortPath === options.portPath && this.currentBaud === options.baudRate) {
      return this.chipInfo!;
    }
    if (this.isConnected) {
      await this.disconnect();
    }

    if (!window?.electronAPI?.SerialPort?.createRaw) {
      throw new Error('当前环境不支持 Node SerialPort（请在 Electron 渲染端运行）');
    }

    const port = new NodeSerialPortAdapter({ path: options.portPath });
    const transport = new Transport(port as any, false);
    const baudrate = options.baudRate;
    const loader = new ESPLoader({
      transport,
      baudrate,
      debugLogging: false,
      terminal: this.buildTerminal(options.onLog),
    });

    try {
      // main() 内部完成：connect (ROM sync) → detectChip → runStub → changeBaud(到 baudrate)
      // → flash 配置探测。这正是 ESPConnect 一次性 handshake 的等价流程。
      const chipName = await loader.main('default_reset');
      const mac = await this.tryReadMac(loader);
      const flashSize = await this.tryReadFlashSize(loader);
      const description = await this.tryReadChipDescription(loader);
      const features = await this.tryReadChipFeatures(loader);
      const crystalFreq = await this.tryReadCrystalFreq(loader);

      this.port = port;
      this.transport = transport;
      this.loader = loader;
      this.currentPortPath = options.portPath;
      this.currentBaud = baudrate;
      this.chipInfo = { chipName, mac, flashSize, description, features, crystalFreq };
      return this.chipInfo;
    } catch (error) {
      try {
        await transport.disconnect();
      } catch {
        // ignore
      }
      try {
        await port.dispose();
      } catch {
        // ignore
      }
      throw new Error(`ESP 连接失败：${this.formatError(error)}`);
    }
  }

  async disconnect(hardReset = true): Promise<void> {
    const loader = this.loader;
    const transport = this.transport;
    const port = this.port;

    this.loader = null;
    this.transport = null;
    this.port = null;
    this.chipInfo = null;
    this.currentPortPath = null;
    this.currentBaud = 0;
    // 中断已 chain 的操作，避免下一次 runExclusive 排在被遗弃的 readFlash 后面。
    this.operationQueue = Promise.resolve();

    // 注意：不走 loader.after('hard_reset')。在 stub 模式下它会写命令等待响应，
    // 这里端口随后即将释放，容易死等。直接用 DTR/RTS 脉冲把 ESP 拉回 ROM 即可。
    if (port && hardReset) {
      try {
        await this.pulseHardReset(port);
      } catch (error) {
        console.warn('[EspSession] DTR/RTS hard reset 失败:', error);
      }
    }

    if (transport) {
      try {
        await transport.disconnect();
      } catch (error) {
        console.warn('[EspSession] 断开 transport 失败:', error);
      }
    }
    if (port) {
      // 无论 transport 是否已调用过 close，这里 dispose 会充分释放底层 OS 句柄（避免被 park）。
      try {
        await port.dispose();
      } catch (error) {
        console.warn('[EspSession] 释放串口失败:', error);
      }
    }
  }

  /**
   * 复刻 ESPConnect 的 readFlashToBuffer：在同一 stub 会话内按 64KB 分块读取，
   * 由 esptool-js 内部包装 ESP_READ_FLASH 命令，全程不复位。
   */
  async readFlash(offset: number, length: number, onProgress?: ReadFlashProgress): Promise<Uint8Array> {
    if (length <= 0) {
      return new Uint8Array(0);
    }
    return this.runExclusive(async loader => {
      const chunkSize = Math.max(FLASH_READ_MIN_CHUNK, Math.min(FLASH_READ_MAX_CHUNK, length));
      const buffers: Uint8Array[] = [];
      let received = 0;
      while (received < length) {
        const remaining = length - received;
        const currentChunkSize = Math.min(chunkSize, remaining);
        const chunkOffset = offset + received;
        const chunkBase = received;
        const chunk = await loader.readFlash(chunkOffset, currentChunkSize, (_packet, packetReceived) => {
          const overall = chunkBase + Math.min(packetReceived, currentChunkSize);
          onProgress?.(overall, length);
        });
        buffers.push(chunk);
        received += chunk.length;
      }
      if (buffers.length === 1) {
        return buffers[0];
      }
      const out = new Uint8Array(received);
      let cursor = 0;
      for (const buf of buffers) {
        out.set(buf, cursor);
        cursor += buf.length;
      }
      return out;
    });
  }

  /**
   * 擦除分区。esptool-js 未暴露 erase_region，这里直接发送 ESP_ERASE_REGION 命令，
   * 与 esptool.py erase_region 等价。
   */
  async erasePartition(offset: number, size: number): Promise<void> {
    if (size <= 0) {
      return;
    }
    await this.runExclusive(async loader => {
      const payload = new Uint8Array(8);
      const view = new DataView(payload.buffer);
      view.setUint32(0, offset, true);
      view.setUint32(4, size, true);
      const timeout = Math.max(loader.timeoutPerMb(loader.ERASE_REGION_TIMEOUT_PER_MB, size), loader.DEFAULT_TIMEOUT);
      await loader.checkCommand('erase region', loader.ESP_ERASE_REGION, payload, 0, timeout);
    });
  }

  /**
   * 写入分区镜像。复刻 ESPConnect 的 writeFilesystemImage：使用 stub 内 deflate flash，
   * 失败抛错；不复位。
   */
  async writePartitionImage(
    offset: number,
    data: Uint8Array,
    onProgress?: WriteFlashProgress,
  ): Promise<void> {
    await this.runExclusive(async loader => {
      await loader.writeFlash({
        fileArray: [{ data, address: offset }],
        flashSize: 'keep',
        flashMode: 'keep',
        flashFreq: 'keep',
        eraseAll: false,
        compress: true,
        reportProgress: (_index, written, total) => {
          onProgress?.(written, total);
        },
      });
    });
  }

  async hardReset(): Promise<void> {
    await this.runExclusive(async loader => {
      await loader.after('hard_reset');
    });
  }

  /**
   * 不依赖 esptool-js loader，直接通过 DTR/RTS 把 ESP 拉回 ROM。
   * ESP32-S3 USB-JTAG-Serial 把 RTS 视作 EN/RESET，DTR 视作 GPIO0。
   * 序列：拉低 reset → 释放 reset（GPIO0=高）→ chip 从 flash 重新运行。
   */
  private async pulseHardReset(port: NodeSerialPortAdapter): Promise<void> {
    const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
    // 进入 reset
    await port.setSignals({ dataTerminalReady: false, requestToSend: true });
    await sleep(100);
    // 释放 reset，GPIO0 保持高 → 从 flash 启动
    await port.setSignals({ dataTerminalReady: false, requestToSend: false });
    await sleep(50);
  }

  private runExclusive<T>(fn: (loader: ESPLoader) => Promise<T>): Promise<T> {
    const next = this.operationQueue.then(async () => {
      const loader = this.loader;
      if (!loader) {
        throw new Error('ESP 设备未连接');
      }
      return fn(loader);
    });
    this.operationQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private buildTerminal(onLog?: (msg: string) => void) {
    return {
      clean: () => { /* no-op */ },
      writeLine: (data: string) => {
        onLog?.(data);
      },
      write: (data: string) => {
        onLog?.(data);
      },
    };
  }

  private async tryReadMac(loader: ESPLoader): Promise<string | undefined> {
    try {
      const mac = await (loader.chip as any).readMac?.(loader);
      return typeof mac === 'string' ? mac : undefined;
    } catch {
      return undefined;
    }
  }

  private async tryReadFlashSize(loader: ESPLoader): Promise<string | undefined> {
    try {
      const id = await loader.readFlashId();
      const sizeId = (id >> 16) & 0xff;
      return loader.DETECTED_FLASH_SIZES[sizeId];
    } catch {
      return undefined;
    }
  }

  private async tryReadChipDescription(loader: ESPLoader): Promise<string | undefined> {
    try {
      const desc = await (loader.chip as any).getChipDescription?.(loader);
      return typeof desc === 'string' ? desc : undefined;
    } catch {
      return undefined;
    }
  }

  private async tryReadChipFeatures(loader: ESPLoader): Promise<string[] | undefined> {
    try {
      const features = await (loader.chip as any).getChipFeatures?.(loader);
      return Array.isArray(features) ? features : undefined;
    } catch {
      return undefined;
    }
  }

  private async tryReadCrystalFreq(loader: ESPLoader): Promise<number | undefined> {
    try {
      const freq = await (loader.chip as any).getCrystalFreq?.(loader);
      return typeof freq === 'number' && Number.isFinite(freq) ? freq : undefined;
    } catch {
      return undefined;
    }
  }

  private formatError(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error || '未知错误');
  }
}
