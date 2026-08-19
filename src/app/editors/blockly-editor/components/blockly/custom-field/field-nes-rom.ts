import * as Blockly from 'blockly/core';

interface NesRomValue {
  fileName: string;
  size: number;
  base64: string;
}

interface FieldNesRomConfig extends Blockly.FieldConfig {
  value?: string;
  maxBytes?: number;
}

/** Serializable local .nes file picker used by the Cycore NES package. */
export class FieldNesRom extends Blockly.Field<string> {
  private readonly maxBytes: number;

  constructor(
    value: string | typeof Blockly.Field.SKIP_SETUP,
    validator?: Blockly.FieldValidator<string>,
    config?: FieldNesRomConfig,
  ) {
    super(value, validator, config);
    this.SERIALIZABLE = true;
    this.maxBytes = Math.max(16, config?.maxBytes ?? 1792 * 1024);
    if (value !== Blockly.Field.SKIP_SETUP && !this.getValue()) this.setValue('');
  }

  static override fromJson(options: FieldNesRomConfig): FieldNesRom {
    return new this(options.value ?? '', undefined, options);
  }

  protected override doClassValidation_(newValue: string): string | null {
    if (newValue === '') return '';
    if (typeof newValue !== 'string') return null;
    const value = this.parseValue(newValue);
    if (!value || !value.fileName || !value.base64 || value.size < 16) return null;
    return JSON.stringify(value);
  }

  override getText(): string {
    const value = this.parseValue(this.getValue());
    if (!value) return '选择 .nes';
    const name = value.fileName.length > 24
      ? value.fileName.slice(0, 10) + '…' + value.fileName.slice(-10)
      : value.fileName;
    return `${name} (${this.formatBytes(value.size)})`;
  }

  protected override showEditor_(): void {
    const root = document.createElement('div');
    root.style.cssText = 'padding:14px;min-width:300px;display:flex;flex-direction:column;gap:10px;background:#fff;color:#222';

    const current = document.createElement('div');
    current.textContent = this.getText();
    current.style.cssText = 'font-size:13px;word-break:break-all';
    root.appendChild(current);

    const hint = document.createElement('div');
    hint.textContent = `仅支持 iNES .nes，单个最大 ${this.formatBytes(this.maxBytes)}`;
    hint.style.cssText = 'font-size:12px;color:#666';
    root.appendChild(hint);

    const buttons = document.createElement('div');
    buttons.style.cssText = 'display:flex;gap:8px';
    root.appendChild(buttons);

    const choose = document.createElement('button');
    choose.type = 'button';
    choose.textContent = '选择 NES ROM';
    choose.style.cssText = 'padding:7px 12px;border:0;border-radius:4px;background:#d6295e;color:#fff;cursor:pointer';
    choose.onclick = () => this.chooseFile();
    buttons.appendChild(choose);

    const clear = document.createElement('button');
    clear.type = 'button';
    clear.textContent = '清除';
    clear.style.cssText = 'padding:7px 12px;border:1px solid #bbb;border-radius:4px;background:#fff;cursor:pointer';
    clear.onclick = () => {
      this.setValue('');
      this.sourceBlock_?.setWarningText(null);
      Blockly.DropDownDiv.hideIfOwner(this, true);
    };
    buttons.appendChild(clear);

    Blockly.DropDownDiv.getContentDiv().appendChild(root);
    Blockly.DropDownDiv.showPositionedByField(this, () => undefined);
  }

  private chooseFile(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.nes,application/octet-stream';
    input.style.display = 'none';
    input.onchange = async () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) return;
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (bytes.length > this.maxBytes) {
          throw new Error(`ROM 超过 ${this.formatBytes(this.maxBytes)}`);
        }
        if (bytes.length < 16 || bytes[0] !== 0x4e || bytes[1] !== 0x45 ||
            bytes[2] !== 0x53 || bytes[3] !== 0x1a) {
          throw new Error('不是有效的 iNES ROM');
        }
        const fileName = this.safeName(file.name);
        this.setValue(JSON.stringify({
          fileName,
          size: bytes.length,
          base64: this.toBase64(bytes),
        } satisfies NesRomValue));
        this.sourceBlock_?.setWarningText(null);
        Blockly.DropDownDiv.hideIfOwner(this, true);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.sourceBlock_?.setWarningText(`NES ROM 读取失败：${message}`);
      }
    };
    document.body.appendChild(input);
    input.click();
  }

  private parseValue(raw: string): NesRomValue | null {
    if (!raw) return null;
    try {
      const value = JSON.parse(raw) as Partial<NesRomValue>;
      if (typeof value.fileName !== 'string' || typeof value.base64 !== 'string' ||
          typeof value.size !== 'number') return null;
      return {fileName: value.fileName, size: value.size, base64: value.base64};
    } catch {
      return null;
    }
  }

  private safeName(name: string): string {
    const base = name.replace(/^.*[\\/]/, '').replace(/[^A-Za-z0-9._ -]/g, '_');
    return /\.nes$/i.test(base) ? base : `${base}.nes`;
  }

  private toBase64(bytes: Uint8Array): string {
    let binary = '';
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
  }

  private formatBytes(bytes: number): string {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${bytes} B`;
  }
}

Blockly.fieldRegistry.register('field_nes_rom', FieldNesRom);
