import * as Blockly from 'blockly/core';

Blockly.Msg['U8G2_ANIMATION_BUTTON_UPLOAD'] = '上传';
Blockly.Msg['U8G2_ANIMATION_UPLOAD_TOOLTIP'] = '支持格式：MP4、GIF、PNG';
Blockly.Msg['U8G2_ANIMATION_BUTTON_CLEAR'] = '清空';
Blockly.Msg['U8G2_ANIMATION_LABEL_WIDTH'] = 'W';
Blockly.Msg['U8G2_ANIMATION_LABEL_HEIGHT'] = 'H';
Blockly.Msg['U8G2_ANIMATION_LABEL_FPS'] = 'FPS';
Blockly.Msg['U8G2_ANIMATION_LABEL_MAX_FRAMES'] = '帧数';
Blockly.Msg['U8G2_ANIMATION_LABEL_THRESHOLD'] = '阈值';
Blockly.Msg['U8G2_ANIMATION_LABEL_THRESHOLD_VALUE'] = '阈值';
Blockly.Msg['U8G2_ANIMATION_LABEL_DITHER'] = '抖动';
Blockly.Msg['U8G2_ANIMATION_EMPTY'] = '未上传动画';
Blockly.Msg['U8G2_ANIMATION_READY'] = '已取模';

export interface U8g2AnimationValue {
    width: number;
    height: number;
    fps: number;
    maxFrames: number;
    dither: boolean;
    threshold: number;
    frames: number[][][];
    sourceName?: string;
    sourceType?: string;
    sourcePath?: string;
}

interface DecodeWorkerMessage {
    type: 'progress' | 'done' | 'error';
    requestId: number;
    message?: string;
    progress?: number;
    result?: U8g2AnimationValue;
}

interface PixelColours {
    readonly empty: string;
    readonly filled: string;
}

interface AnimationDecodeSource {
    fileName: string;
    mimeType: string;
    buffer: ArrayBuffer;
    sourcePath?: string;
}

export interface FieldU8g2AnimationFromJsonConfig extends Blockly.FieldConfig {
    value?: U8g2AnimationValue;
    width?: number;
    height?: number;
    fps?: number;
    maxFrames?: number;
    dither?: boolean;
    threshold?: number;
    fieldHeight?: number;
    colours?: PixelColours;
}

const DEFAULT_WIDTH = 128;
const DEFAULT_HEIGHT = 64;
const DEFAULT_FPS = 10;
const DEFAULT_MAX_FRAMES = 30;
const DEFAULT_THRESHOLD = 127;
const DEFAULT_FIELD_HEIGHT = 32;
const MAX_SOURCE_FILE_SIZE_BYTES = 10 * 1024 * 1024;
const DEFAULT_PIXEL_COLOURS: PixelColours = {
    empty: '#151515',
    filled: '#f4f4f4',
};
const LIGHT_PIXEL_COLOURS: PixelColours = {
    empty: '#ffffff',
    filled: '#111827',
};
let u8g2AnimationModeCounter = 0;

export class FieldU8g2Animation extends Blockly.Field<U8g2AnimationValue> {
    private readonly bitmapModeInputName = `u8g2AnimationMode-${++u8g2AnimationModeCounter}`;
    private initialValue: U8g2AnimationValue | null = null;
    private imgWidth: number;
    private imgHeight: number;
    private fps: number;
    private maxFrames: number;
    private dither: boolean;
    private threshold: number;
    private fieldHeight: number;
    private pixelSize: number;
    private pixelColours: PixelColours;
    private readonly hasCustomPixelColours: boolean;
    private blockDisplayImage: SVGImageElement | null = null;
    private frameStrip: HTMLElement | null = null;
    private statusElement: HTMLElement | null = null;
    private fileInput: HTMLInputElement | null = null;
    private widthInput: HTMLInputElement | null = null;
    private heightInput: HTMLInputElement | null = null;
    private fpsInput: HTMLInputElement | null = null;
    private maxFramesInput: HTMLInputElement | null = null;
    private thresholdInput: HTMLInputElement | null = null;
    private ditherInput: HTMLInputElement | null = null;
    private thresholdValueControl: HTMLElement | null = null;
    private thresholdValueInput: HTMLInputElement | null = null;
    private boundEvents: Blockly.browserEvents.Data[] = [];
    private decodeWorker: Worker | null = null;
    private sourceRedecodeTimer: ReturnType<typeof setTimeout> | null = null;
    private sourceRedecodeInProgress = false;
    private sourceRedecodePending = false;
    private sourceRedecodeVersion = 0;
    private requestId = 0;

    constructor(
        value: U8g2AnimationValue | typeof Blockly.Field.SKIP_SETUP,
        validator?: Blockly.FieldValidator<U8g2AnimationValue>,
        config?: FieldU8g2AnimationFromJsonConfig,
    ) {
        super(value, validator, config);
        this.SERIALIZABLE = true;

        const normalized = this.normalizeValue(
            value === Blockly.Field.SKIP_SETUP ? config?.value : value,
            config,
        );

        this.imgWidth = normalized.width;
        this.imgHeight = normalized.height;
        this.fps = normalized.fps;
        this.maxFrames = normalized.maxFrames;
        this.dither = normalized.dither;
        this.threshold = normalized.threshold;
        this.fieldHeight = config?.fieldHeight ?? DEFAULT_FIELD_HEIGHT;
        this.hasCustomPixelColours = !!config?.colours;
        this.pixelColours = this.resolvePixelColours(config?.colours);
        this.pixelSize = this.getPixelSize();

        if (value === Blockly.Field.SKIP_SETUP && !config?.value) {
            this.setValue(normalized);
        }
    }

    static override fromJson(options: FieldU8g2AnimationFromJsonConfig) {
        return new this(
            options.value ?? Blockly.Field.SKIP_SETUP,
            undefined,
            options,
        );
    }

    protected override doClassValidation_(
        newValue?: U8g2AnimationValue,
    ): U8g2AnimationValue | null | undefined {
        if (!newValue || typeof newValue !== 'object') {
            return null;
        }

        const normalized = this.normalizeValue(newValue);
        if (!this.isValidFrames(normalized.frames, normalized.width, normalized.height)) {
            return null;
        }

        return normalized;
    }

    protected override doValueUpdate_(newValue: U8g2AnimationValue) {
        this.value_ = this.cloneValue(newValue);
        this.imgWidth = newValue.width;
        this.imgHeight = newValue.height;
        this.fps = newValue.fps;
        this.maxFrames = newValue.maxFrames;
        this.dither = newValue.dither;
        this.threshold = newValue.threshold;
        this.pixelSize = this.getPixelSize();
        this.updateSize_();
        this.updateBlockDisplayImage();
        this.updateControlsFromValue();
        this.renderFrameStrip();
    }

    protected override showEditor_(e?: Event) {
        this.refreshThemeColours();
        const editor = this.dropdownCreate();
        Blockly.DropDownDiv.getContentDiv().appendChild(editor);
        Blockly.DropDownDiv.showPositionedByField(
            this,
            this.dropdownDispose.bind(this),
        );
    }

    protected override render_() {
        super.render_();
        this.refreshThemeColours();
        this.updateBlockDisplayImage();
    }

    override initView() {
        this.blockDisplayImage = Blockly.utils.dom.createSvgElement(
            'image',
            {
                x: 0,
                y: 0,
                width: this.pixelSize * this.imgWidth,
                height: this.pixelSize * this.imgHeight,
                style: 'image-rendering: pixelated; cursor: pointer;',
            },
            this.getSvgRoot(),
        ) as SVGImageElement;

        this.updateBlockDisplayImage();
    }

    override updateEditable() {
        const editable = super.updateEditable();
        const svgRoot = this.getSvgRoot();
        if (svgRoot) {
            Blockly.utils.dom.removeClass(svgRoot, 'blocklyNonEditableText');
            Blockly.utils.dom.removeClass(svgRoot, 'blocklyEditableText');
        }
        return editable;
    }

    override getScaledBBox() {
        const boundingBox = this.getSvgRoot()?.getBoundingClientRect();
        if (!boundingBox) {
            throw new Error('Tried to retrieve a bounding box without a rect');
        }
        return new Blockly.utils.Rect(
            boundingBox.top,
            boundingBox.bottom,
            boundingBox.left,
            boundingBox.right,
        );
    }

    protected override updateSize_() {
        const newWidth = this.pixelSize * this.imgWidth;
        const newHeight = this.pixelSize * this.imgHeight;

        if (this.borderRect_) {
            this.borderRect_.setAttribute('width', String(newWidth));
            this.borderRect_.setAttribute('height', String(newHeight));
        }
        if (this.blockDisplayImage) {
            this.blockDisplayImage.setAttribute('width', String(newWidth));
            this.blockDisplayImage.setAttribute('height', String(newHeight));
        }

        this.size_.width = newWidth;
        this.size_.height = newHeight;
    }

    override dispose() {
        this.clearSourceRedecodeTimer();
        this.terminateWorker();
        for (const event of this.boundEvents) {
            Blockly.browserEvents.unbind(event);
        }
        this.boundEvents.length = 0;
        super.dispose();
    }

    private dropdownCreate() {
        const dropdownEditor = this.createElementWithClassname(
            'div',
            'u8g2AnimationEditor',
        );
        this.bindEditorContainerEvents(dropdownEditor);

        dropdownEditor.appendChild(this.createToolbar());
        dropdownEditor.appendChild(this.createStatus());

        this.frameStrip = this.createElementWithClassname('div', 'u8g2AnimationFrameStrip');
        dropdownEditor.appendChild(this.frameStrip);
        this.renderFrameStrip();

        Blockly.DropDownDiv.getContentDiv().classList.add('contains-u8g2-animation-editor');
        this.initialValue = this.cloneValue(this.getValue());

        return dropdownEditor;
    }

    private createToolbar() {
        const toolbar = this.createElementWithClassname('div', 'u8g2AnimationToolbar');
        const dimensionGroup = this.createElementWithClassname('div', 'u8g2AnimationControlGroup');

        this.widthInput = this.createNumberInput('W', this.imgWidth, 1, 256);
        this.heightInput = this.createNumberInput('H', this.imgHeight, 1, 128);
        this.fpsInput = this.createNumberInput('FPS', this.fps, 1, 60);
        this.maxFramesInput = this.createNumberInput('Max frames', this.maxFrames, 1, 500);
        this.thresholdInput = this.createBitmapModeInput('Threshold', 'threshold', !this.dither);
        this.ditherInput = this.createBitmapModeInput('Dither', 'dither', this.dither);
        this.thresholdValueInput = this.createThresholdValueInput(this.threshold);

        this.bindDimensionInputEvents(this.widthInput);
        this.bindDimensionInputEvents(this.heightInput);
        this.bindPlaybackInputEvents(this.fpsInput);
        this.bindPlaybackInputEvents(this.maxFramesInput);
        this.bindBitmapModeInputEvents(this.thresholdInput);
        this.bindBitmapModeInputEvents(this.ditherInput);
        this.bindThresholdValueInputEvents(this.thresholdValueInput);

        dimensionGroup.appendChild(this.createNumberControl(Blockly.Msg['U8G2_ANIMATION_LABEL_WIDTH'], this.widthInput));
        dimensionGroup.appendChild(this.createNumberControl(Blockly.Msg['U8G2_ANIMATION_LABEL_HEIGHT'], this.heightInput));
        dimensionGroup.appendChild(this.createNumberControl(Blockly.Msg['U8G2_ANIMATION_LABEL_FPS'], this.fpsInput));
        dimensionGroup.appendChild(this.createNumberControl(Blockly.Msg['U8G2_ANIMATION_LABEL_MAX_FRAMES'], this.maxFramesInput));
        dimensionGroup.appendChild(this.createBitmapModeControl(Blockly.Msg['U8G2_ANIMATION_LABEL_DITHER'], this.ditherInput));
        dimensionGroup.appendChild(this.createBitmapModeControl(Blockly.Msg['U8G2_ANIMATION_LABEL_THRESHOLD'], this.thresholdInput));
        this.thresholdValueControl = this.createThresholdValueControl(this.thresholdValueInput);
        dimensionGroup.appendChild(this.thresholdValueControl);
        this.updateThresholdValueVisibility();
        toolbar.appendChild(dimensionGroup);

        const actionGroup = this.createElementWithClassname('div', 'u8g2AnimationButtonGroup');
        this.fileInput = document.createElement('input');
        this.fileInput.type = 'file';
        this.fileInput.accept = 'video/mp4,image/gif,image/png,.mp4,.gif,.png';
        this.fileInput.style.display = 'none';
        actionGroup.appendChild(this.fileInput);
        this.bindEvent(this.fileInput, 'change', this.onFileSelected.bind(this));

        this.addControlButton(
            actionGroup,
            Blockly.Msg['U8G2_ANIMATION_BUTTON_UPLOAD'],
            () => this.fileInput?.click(),
            Blockly.Msg['U8G2_ANIMATION_UPLOAD_TOOLTIP'],
        );
        this.addControlButton(
            actionGroup,
            Blockly.Msg['U8G2_ANIMATION_BUTTON_CLEAR'],
            () => this.clearAnimation(),
        );
        toolbar.appendChild(actionGroup);

        return toolbar;
    }

    private createStatus() {
        this.statusElement = this.createElementWithClassname('div', 'u8g2AnimationStatus');
        this.updateStatusFromValue();
        return this.statusElement;
    }

    private createNumberInput(ariaLabel: string, value: number, min: number, max: number) {
        const input = document.createElement('input');
        input.type = 'number';
        input.className = 'u8g2AnimationNumberInput';
        input.min = String(min);
        input.max = String(max);
        input.value = String(value);
        input.setAttribute('aria-label', ariaLabel);
        return input;
    }

    private createBitmapModeInput(ariaLabel: string, value: 'threshold' | 'dither', checked: boolean) {
        const input = document.createElement('input');
        input.type = 'radio';
        input.className = 'u8g2AnimationModeInput';
        input.name = this.bitmapModeInputName;
        input.value = value;
        input.checked = checked;
        input.setAttribute('aria-label', ariaLabel);
        return input;
    }

    private createThresholdValueInput(value: number) {
        const input = document.createElement('input');
        input.type = 'number';
        input.className = 'u8g2AnimationThresholdValueInput';
        input.min = '0';
        input.max = '255';
        input.step = '1';
        input.value = String(value);
        input.setAttribute('aria-label', Blockly.Msg['U8G2_ANIMATION_LABEL_THRESHOLD_VALUE']);
        return input;
    }

    private createNumberControl(labelText: string, input: HTMLInputElement) {
        const control = this.createElementWithClassname('label', 'u8g2AnimationNumberControl');
        const label = document.createElement('span');
        label.textContent = labelText;
        control.appendChild(label);
        control.appendChild(input);
        return control;
    }

    private createBitmapModeControl(labelText: string, input: HTMLInputElement) {
        const control = this.createElementWithClassname('label', 'u8g2AnimationModeControl');
        control.appendChild(input);
        const label = document.createElement('span');
        label.textContent = labelText;
        control.appendChild(label);
        return control;
    }

    private createThresholdValueControl(input: HTMLInputElement) {
        const control = this.createElementWithClassname('span', 'u8g2AnimationThresholdValueControl');
        control.appendChild(input);
        return control;
    }

    private addControlButton(
        parent: HTMLElement,
        buttonText: string,
        onClick: (e?: Event) => void,
        tooltip?: string,
    ) {
        const button = this.createElementWithClassname('button', 'u8g2AnimationButton');
        button.textContent = buttonText;
        if (tooltip) {
            button.title = tooltip;
        }
        parent.appendChild(button);
        this.bindEvent(button, 'click', onClick);
        return button;
    }

    private bindDimensionInputEvents(input: HTMLInputElement) {
        this.bindEvent(input, 'change', this.onDimensionInputChange.bind(this));
        this.bindEvent(input, 'input', this.onDimensionInputChange.bind(this));
    }

    private bindPlaybackInputEvents(input: HTMLInputElement) {
        this.bindEvent(input, 'change', this.onPlaybackInputChange.bind(this));
        this.bindEvent(input, 'input', this.onPlaybackInputChange.bind(this));
    }

    private bindBitmapModeInputEvents(input: HTMLInputElement) {
        this.bindEvent(input, 'change', this.onBitmapModeInputChange.bind(this));
    }

    private bindThresholdValueInputEvents(input: HTMLInputElement) {
        this.bindEvent(input, 'input', this.onThresholdValueInputChange.bind(this));
        this.bindEvent(input, 'change', this.onThresholdValueInputChange.bind(this));
    }

    private bindEditorContainerEvents(dropdownEditor: HTMLElement) {
        const stopEventPropagation = (event: Event) => event.stopPropagation();
        const stopContextMenu = (event: Event) => {
            event.preventDefault();
            event.stopPropagation();
        };

        for (const eventName of [
            'pointerdown',
            'pointermove',
            'pointerup',
            'mousedown',
            'mousemove',
            'mouseup',
            'click',
            'dblclick',
            'touchstart',
            'touchmove',
            'touchend',
        ]) {
            this.bindEvent(dropdownEditor, eventName, stopEventPropagation);
        }
        this.bindEvent(dropdownEditor, 'contextmenu', stopContextMenu);
    }

    private onDimensionInputChange() {
        if (!this.widthInput || !this.heightInput) return;
        if (this.widthInput.value === '' || this.heightInput.value === '') return;

        const nextWidth = this.clampInput(this.widthInput, this.imgWidth);
        const nextHeight = this.clampInput(this.heightInput, this.imgHeight);
        this.widthInput.value = String(nextWidth);
        this.heightInput.value = String(nextHeight);

        if (nextWidth === this.imgWidth && nextHeight === this.imgHeight) return;

        const currentValue = this.getValue();
        const nextValue: U8g2AnimationValue = {
            ...currentValue,
            width: nextWidth,
            height: nextHeight,
            frames: this.resizeFrames(currentValue.frames, nextWidth, nextHeight),
        };

        this.setValue(nextValue, false);
        this.rerenderSourceBlockAfterResize();
        this.scheduleRedecodeFromSource();
    }

    private onPlaybackInputChange() {
        if (!this.fpsInput || !this.maxFramesInput) return;
        if (this.fpsInput.value === '' || this.maxFramesInput.value === '') return;

        const nextFps = this.clampInput(this.fpsInput, this.fps);
        const nextMaxFrames = this.clampInput(this.maxFramesInput, this.maxFrames);
        this.fpsInput.value = String(nextFps);
        this.maxFramesInput.value = String(nextMaxFrames);

        if (nextFps === this.fps && nextMaxFrames === this.maxFrames) return;

        const currentValue = this.getValue();
        this.setValue({
            ...currentValue,
            fps: nextFps,
            maxFrames: nextMaxFrames,
        }, false);
        this.scheduleRedecodeFromSource();
    }

    private onBitmapModeInputChange() {
        if (!this.thresholdInput || !this.ditherInput) return;

        if (!this.thresholdInput.checked && !this.ditherInput.checked) {
            this.thresholdInput.checked = true;
        }

        const nextDither = this.ditherInput.checked;
        this.thresholdInput.checked = !nextDither;
        this.ditherInput.checked = nextDither;
        this.updateThresholdValueVisibility();

        const currentValue = this.getValue();
        if (currentValue.dither === nextDither) return;

        this.setValue({
            ...currentValue,
            dither: nextDither,
        }, false);
        this.scheduleRedecodeFromSource();
    }

    private onThresholdValueInputChange() {
        if (!this.thresholdValueInput) return;
        if (this.thresholdValueInput.value === '') return;

        const nextThreshold = this.clampInput(this.thresholdValueInput, this.threshold);
        this.thresholdValueInput.value = String(nextThreshold);
        this.threshold = nextThreshold;

        const currentValue = this.getValue();
        if (currentValue.threshold === nextThreshold) return;

        this.setValue({
            ...currentValue,
            threshold: nextThreshold,
        }, false);
        this.scheduleRedecodeFromSource();
    }

    private async onFileSelected(event: Event) {
        const input = event.target as HTMLInputElement;
        const file = input.files?.[0];
        if (!file) return;

        input.value = '';
        const width = this.widthInput ? this.clampInput(this.widthInput, this.imgWidth) : this.imgWidth;
        const height = this.heightInput ? this.clampInput(this.heightInput, this.imgHeight) : this.imgHeight;
        const fps = this.fpsInput ? this.clampInput(this.fpsInput, this.fps) : this.fps;
        const maxFrames = this.maxFramesInput ? this.clampInput(this.maxFramesInput, this.maxFrames) : this.maxFrames;
        const dither = this.ditherInput ? this.ditherInput.checked : this.dither;
        const threshold = this.thresholdValueInput ? this.clampInput(this.thresholdValueInput, this.threshold) : this.threshold;

        try {
            if (file.size > MAX_SOURCE_FILE_SIZE_BYTES) {
                throw new Error(`文件大小不能超过 10MB，当前文件 ${this.formatFileSize(file.size)}`);
            }

            this.setStatus(`正在读取 ${file.name}...`);
            const buffer = await file.arrayBuffer();
            this.invalidateSourceRedecode();
            this.clearSourceRedecodeTimer();
            this.setStatus(`正在保存 ${file.name}...`);
            const sourcePath = this.persistSourceFile(file, buffer);
            await this.decodeAnimation({
                fileName: file.name,
                mimeType: file.type || this.inferMimeType(file.name),
                buffer,
                sourcePath,
            }, width, height, fps, maxFrames, dither, threshold);
        } catch (error: any) {
            this.setStatus(error?.message || '动画取模失败', true);
        }
    }

    private async decodeAnimation(
        source: AnimationDecodeSource,
        width: number,
        height: number,
        fps: number,
        maxFrames: number,
        dither: boolean,
        threshold: number,
        shouldApplyResult: () => boolean = () => true,
    ) {
        this.terminateWorker();
        const worker = new Worker(
            new URL('./u8g2-animation-decoder.worker.ts', import.meta.url),
            { type: 'module' },
        );
        this.decodeWorker = worker;
        const requestId = ++this.requestId;

        try {
            await new Promise<void>((resolve, reject) => {
                worker.onmessage = (event: MessageEvent<DecodeWorkerMessage>) => {
                    const message = event.data;
                    if (!message || message.requestId !== requestId) return;

                    if (message.type === 'progress') {
                        this.setStatus(message.message || '正在取模...');
                        return;
                    }

                    if (message.type === 'done' && message.result) {
                        const result: U8g2AnimationValue = {
                            ...message.result,
                            sourceName: source.fileName,
                            sourceType: source.mimeType || message.result.sourceType,
                            sourcePath: source.sourcePath,
                        };
                        if (shouldApplyResult()) {
                            this.setValue(result, false);
                            this.setStatus(`${Blockly.Msg['U8G2_ANIMATION_READY']} ${result.frames.length} 帧`);
                        }
                        resolve();
                        return;
                    }

                    if (message.type === 'error') {
                        if (shouldApplyResult()) {
                            reject(new Error(message.message || '动画取模失败'));
                        } else {
                            resolve();
                        }
                    }
                };

                worker.onerror = (error) => {
                    if (shouldApplyResult()) {
                        reject(new Error(error.message || 'Worker 执行失败'));
                    } else {
                        resolve();
                    }
                };

                worker.postMessage({
                    type: 'decode',
                    requestId,
                    fileName: source.fileName,
                    mimeType: source.mimeType,
                    buffer: source.buffer,
                    width,
                    height,
                    fps,
                    maxFrames,
                    dither,
                    threshold,
                }, [source.buffer]);
            });
        } finally {
            if (this.decodeWorker === worker) {
                this.terminateWorker();
            }
        }
    }

    private persistSourceFile(file: File, buffer: ArrayBuffer): string {
        const projectPath = this.getCurrentProjectPath();
        const fsApi = (window as any)['fs'];
        const pathApi = (window as any)['path'];

        if (!projectPath || !fsApi || !pathApi?.join || !pathApi?.relative) {
            throw new Error('未找到当前项目目录，无法保存动画资源');
        }

        if (typeof fsApi.mkdirSync !== 'function') {
            throw new Error('文件系统接口不可用，无法创建 assets 目录');
        }

        const assetsDir = pathApi.join(projectPath, 'assets', 'u8g2-animation');
        fsApi.mkdirSync(assetsDir);

        const sourceExt = this.getSourceExtension(file.name, file.type);
        const fileMd5 = this.calculateSourceMd5(buffer, fsApi);
        const fileName = `${fileMd5}${sourceExt}`;
        const assetFilePath = pathApi.join(assetsDir, fileName);

        if (typeof fsApi.existsSync === 'function' && fsApi.existsSync(assetFilePath)) {
            return this.normalizeAssetPath(pathApi.relative(projectPath, assetFilePath));
        }

        if (typeof fsApi.writeFileBuffer === 'function') {
            fsApi.writeFileBuffer(assetFilePath, buffer);
        } else if (typeof fsApi.writeFileSync === 'function') {
            fsApi.writeFileSync(assetFilePath, new Uint8Array(buffer));
        } else if (typeof fsApi.writeBase64File === 'function') {
            fsApi.writeBase64File(assetFilePath, this.arrayBufferToBase64(buffer));
        } else {
            throw new Error('文件系统接口不可用，无法保存动画资源');
        }

        return this.normalizeAssetPath(pathApi.relative(projectPath, assetFilePath));
    }

    private scheduleRedecodeFromSource(delayMs = 800) {
        const value = this.getValue();
        if (!value?.sourcePath) return;

        this.sourceRedecodeVersion += 1;
        this.clearSourceRedecodeTimer();
        this.sourceRedecodeTimer = setTimeout(() => {
            this.sourceRedecodeTimer = null;
            void this.redecodeFromSource();
        }, delayMs);
    }

    private clearSourceRedecodeTimer() {
        if (this.sourceRedecodeTimer) {
            clearTimeout(this.sourceRedecodeTimer);
            this.sourceRedecodeTimer = null;
        }
    }

    private invalidateSourceRedecode() {
        this.sourceRedecodeVersion += 1;
        this.sourceRedecodePending = false;
    }

    private async redecodeFromSource() {
        if (this.sourceRedecodeInProgress) {
            this.sourceRedecodePending = true;
            return;
        }

        const value = this.getValue();
        if (!value?.sourcePath) return;

        const sourceFilePath = this.resolveSourceFilePath(value.sourcePath);
        const fsApi = (window as any)['fs'];
        if (!sourceFilePath || (!fsApi?.readFileBuffer && !fsApi?.readFileAsBase64)) {
            this.setStatus('未找到动画源文件，无法重新取模', true);
            return;
        }

        if (typeof fsApi.existsSync === 'function' && !fsApi.existsSync(sourceFilePath)) {
            this.setStatus(`源文件不存在: ${value.sourcePath}`, true);
            return;
        }

        const decodeVersion = this.sourceRedecodeVersion;
        this.sourceRedecodeInProgress = true;
        try {
            const sourceName = value.sourceName || this.getPathBaseName(value.sourcePath);
            this.setStatus(`正在重新取模 ${sourceName}...`);
            const buffer = this.readSourceFileBuffer(sourceFilePath, fsApi);
            await this.decodeAnimation({
                fileName: sourceName,
                mimeType: value.sourceType || this.inferMimeType(value.sourcePath),
                buffer,
                sourcePath: value.sourcePath,
            }, value.width, value.height, value.fps, value.maxFrames, value.dither, value.threshold, () => decodeVersion === this.sourceRedecodeVersion);
        } catch (error: any) {
            if (decodeVersion === this.sourceRedecodeVersion) {
                this.setStatus(error?.message || '重新取模失败', true);
            }
        } finally {
            this.sourceRedecodeInProgress = false;
            if (this.sourceRedecodePending) {
                this.sourceRedecodePending = false;
                this.scheduleRedecodeFromSource(0);
            }
        }
    }

    private readSourceFileBuffer(sourceFilePath: string, fsApi: any): ArrayBuffer {
        if (typeof fsApi.readFileBuffer === 'function') {
            return this.toArrayBuffer(fsApi.readFileBuffer(sourceFilePath));
        }

        if (typeof fsApi.readFileAsBase64 === 'function') {
            return this.base64ToArrayBuffer(fsApi.readFileAsBase64(sourceFilePath));
        }

        throw new Error('文件系统接口不可用，无法读取动画源文件');
    }

    private toArrayBuffer(data: unknown): ArrayBuffer {
        if (data instanceof ArrayBuffer) {
            return data;
        }

        if (ArrayBuffer.isView(data)) {
            const view = data as ArrayBufferView;
            return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
        }

        if (Array.isArray(data)) {
            return new Uint8Array(data).buffer;
        }

        const maybeBuffer = data as { type?: string; data?: unknown };
        if (maybeBuffer?.type === 'Buffer' && Array.isArray(maybeBuffer.data)) {
            return new Uint8Array(maybeBuffer.data).buffer;
        }

        throw new Error('动画源文件读取结果无效');
    }

    private resolveSourceFilePath(sourcePath: string): string | null {
        const projectPath = this.getCurrentProjectPath();
        const pathApi = (window as any)['path'];
        if (!projectPath || !sourcePath || !pathApi?.join || !pathApi?.resolve || !pathApi?.relative) {
            return null;
        }

        const trimmedSourcePath = sourcePath.trim();
        const isAbsolute = typeof pathApi.isAbsolute === 'function' && pathApi.isAbsolute(trimmedSourcePath);
        const fullPath = isAbsolute
            ? trimmedSourcePath
            : pathApi.join(projectPath, ...trimmedSourcePath.split(/[\\/]+/).filter(Boolean));
        const projectRoot = pathApi.resolve(projectPath);
        const resolvedFullPath = pathApi.resolve(fullPath);
        const relativePath = pathApi.relative(projectRoot, resolvedFullPath);

        if (relativePath.startsWith('..') || (typeof pathApi.isAbsolute === 'function' && pathApi.isAbsolute(relativePath))) {
            return null;
        }

        return resolvedFullPath;
    }

    private getCurrentProjectPath(): string | null {
        const projectServicePath = (window as any)['projectService']?.currentProjectPath;
        if (typeof projectServicePath === 'string' && projectServicePath.trim()) {
            return projectServicePath;
        }

        const searchPath = new URLSearchParams(window.location.search).get('path');
        if (searchPath) {
            return searchPath;
        }

        const hashQueryIndex = window.location.hash.indexOf('?');
        if (hashQueryIndex >= 0) {
            const hashPath = new URLSearchParams(window.location.hash.slice(hashQueryIndex + 1)).get('path');
            if (hashPath) {
                return hashPath;
            }
        }

        return null;
    }

    private getSourceExtension(fileName: string, mimeType?: string) {
        const ext = this.getPathExtension(fileName).toLowerCase();
        if (ext === '.mp4' || ext === '.gif' || ext === '.png') {
            return ext;
        }

        switch ((mimeType || '').toLowerCase()) {
            case 'video/mp4':
                return '.mp4';
            case 'image/gif':
                return '.gif';
            case 'image/png':
                return '.png';
            default:
                return '.bin';
        }
    }

    private calculateSourceMd5(buffer: ArrayBuffer, fsApi: any) {
        if (typeof fsApi.md5Buffer !== 'function') {
            throw new Error('文件 MD5 接口不可用，请完全重启软件后再上传');
        }

        const md5 = String(fsApi.md5Buffer(buffer) || '').toLowerCase();
        if (!/^[a-f0-9]{32}$/.test(md5)) {
            throw new Error('文件 MD5 计算失败');
        }
        return md5;
    }

    private inferMimeType(fileName: string) {
        switch (this.getPathExtension(fileName).toLowerCase()) {
            case '.mp4':
                return 'video/mp4';
            case '.gif':
                return 'image/gif';
            case '.png':
                return 'image/png';
            default:
                return '';
        }
    }

    private getPathExtension(fileName: string) {
        const pathApi = (window as any)['path'];
        if (pathApi?.extname) {
            return pathApi.extname(fileName) || '';
        }
        const match = /\.[^./\\]+$/.exec(fileName);
        return match?.[0] || '';
    }

    private getPathBaseName(fileName: string) {
        const pathApi = (window as any)['path'];
        if (pathApi?.basename) {
            return pathApi.basename(fileName);
        }
        return fileName.split(/[\\/]/).pop() || fileName;
    }

    private normalizeAssetPath(assetPath: string) {
        return assetPath.replace(/\\/g, '/').replace(/^\.\//, '');
    }

    private formatFileSize(bytes: number) {
        if (!Number.isFinite(bytes) || bytes <= 0) {
            return '0 MB';
        }
        return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
    }

    private arrayBufferToBase64(buffer: ArrayBuffer) {
        const bytes = new Uint8Array(buffer);
        let binary = '';
        const chunkSize = 0x8000;
        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
            const chunk = bytes.subarray(offset, offset + chunkSize);
            binary += String.fromCharCode(...chunk);
        }
        return btoa(binary);
    }

    private base64ToArrayBuffer(base64: string) {
        const rawBase64 = base64.includes(',') ? base64.split(',').pop() || '' : base64;
        const binary = atob(rawBase64);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index++) {
            bytes[index] = binary.charCodeAt(index);
        }
        return bytes.buffer;
    }

    private clearAnimation() {
        this.invalidateSourceRedecode();
        this.clearSourceRedecodeTimer();
        this.setValue(this.createEmptyValue(), false);
        this.setStatus(Blockly.Msg['U8G2_ANIMATION_EMPTY']);
    }

    private renderFrameStrip() {
        if (!this.frameStrip) return;

        this.frameStrip.replaceChildren();
        const value = this.getValue();
        const frames = value.frames || [];

        if (!frames.length) {
            const empty = this.createElementWithClassname('div', 'u8g2AnimationEmpty');
            empty.textContent = Blockly.Msg['U8G2_ANIMATION_EMPTY'];
            this.frameStrip.appendChild(empty);
            return;
        }

        frames.forEach((frame, index) => {
            const item = this.createElementWithClassname('div', 'u8g2AnimationFrameItem');
            const canvas = this.renderBitmapToCanvas(frame, value.width, value.height, this.getPreviewScale(value.width, value.height));
            const label = document.createElement('span');
            label.textContent = String(index + 1);
            item.appendChild(canvas);
            item.appendChild(label);
            this.frameStrip?.appendChild(item);
        });
    }

    private updateBlockDisplayImage() {
        if (!this.blockDisplayImage) return;
        const value = this.getValue();
        const firstFrame = value?.frames?.[0] || this.createEmptyFrame(value?.width || this.imgWidth, value?.height || this.imgHeight);
        const canvas = this.renderBitmapToCanvas(firstFrame, value.width, value.height, 1);
        const dataUrl = canvas.toDataURL();
        this.blockDisplayImage.setAttribute('href', dataUrl);
        this.blockDisplayImage.setAttributeNS('http://www.w3.org/1999/xlink', 'href', dataUrl);
    }

    private renderBitmapToCanvas(frame: number[][], width: number, height: number, scale: number) {
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, width * scale);
        canvas.height = Math.max(1, height * scale);
        canvas.className = 'u8g2AnimationCanvas';

        const context = canvas.getContext('2d');
        if (!context) return canvas;

        context.imageSmoothingEnabled = false;
        const imageData = context.createImageData(width, height);
        const filled = this.hexToRgb(this.pixelColours.filled);
        const empty = this.hexToRgb(this.pixelColours.empty);

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const targetIndex = (y * width + x) * 4;
                const isFilled = frame[y]?.[x] === 1;
                const color = isFilled ? filled : empty;
                imageData.data[targetIndex] = color.r;
                imageData.data[targetIndex + 1] = color.g;
                imageData.data[targetIndex + 2] = color.b;
                imageData.data[targetIndex + 3] = 255;
            }
        }

        const rawCanvas = document.createElement('canvas');
        rawCanvas.width = width;
        rawCanvas.height = height;
        const rawContext = rawCanvas.getContext('2d');
        rawContext?.putImageData(imageData, 0, 0);
        context.drawImage(rawCanvas, 0, 0, canvas.width, canvas.height);

        return canvas;
    }

    private updateControlsFromValue() {
        if (this.widthInput) this.widthInput.value = String(this.imgWidth);
        if (this.heightInput) this.heightInput.value = String(this.imgHeight);
        if (this.fpsInput) this.fpsInput.value = String(this.fps);
        if (this.maxFramesInput) this.maxFramesInput.value = String(this.maxFrames);
        if (this.thresholdInput) this.thresholdInput.checked = !this.dither;
        if (this.ditherInput) this.ditherInput.checked = this.dither;
        if (this.thresholdValueInput) this.thresholdValueInput.value = String(this.threshold);
        this.updateThresholdValueVisibility();
        this.updateStatusFromValue();
    }

    private updateThresholdValueVisibility() {
        const isThresholdMode = !this.ditherInput?.checked;
        if (this.thresholdValueControl) {
            this.thresholdValueControl.style.display = isThresholdMode ? 'inline-flex' : 'none';
        }
        if (this.thresholdValueInput) {
            this.thresholdValueInput.disabled = !isThresholdMode;
        }
    }

    private updateStatusFromValue() {
        const value = this.getValue();
        if (!this.statusElement) return;
        if (value.frames.length <= 1 && !value.sourceName) {
            this.statusElement.textContent = Blockly.Msg['U8G2_ANIMATION_EMPTY'];
            this.statusElement.classList.remove('is-error');
            return;
        }

        const source = value.sourceName ? `${value.sourceName} · ` : '';
        const modeText = value.dither
            ? Blockly.Msg['U8G2_ANIMATION_LABEL_DITHER']
            : `${Blockly.Msg['U8G2_ANIMATION_LABEL_THRESHOLD']} ${value.threshold}`;
        this.statusElement.textContent = `${source}${value.frames.length} 帧 · ${value.width}x${value.height} · ${value.fps} FPS · ${modeText}`;
        this.statusElement.classList.remove('is-error');
    }

    private setStatus(message: string, isError = false) {
        if (!this.statusElement) return;
        this.statusElement.textContent = message;
        this.statusElement.classList.toggle('is-error', isError);
    }

    private refreshThemeColours() {
        if (this.hasCustomPixelColours) return;
        const nextColours = this.resolvePixelColours();
        if (
            nextColours.empty === this.pixelColours.empty &&
            nextColours.filled === this.pixelColours.filled
        ) {
            return;
        }

        this.pixelColours = nextColours;
        this.renderFrameStrip();
        this.updateBlockDisplayImage();
    }

    private resolvePixelColours(customColours?: PixelColours): PixelColours {
        const baseColours = this.isLightTheme() ? LIGHT_PIXEL_COLOURS : DEFAULT_PIXEL_COLOURS;
        return { ...baseColours, ...customColours };
    }

    private isLightTheme() {
        return document.documentElement.dataset['theme'] === 'light' ||
            document.documentElement.classList.contains('llight') ||
            document.body.classList.contains('llight');
    }

    private getPixelSize() {
        return this.fieldHeight / Math.max(1, this.imgHeight);
    }

    private getPreviewScale(width: number, height: number) {
        const maxSide = Math.max(width, height);
        if (maxSide <= 32) return 3.5;
        if (maxSide <= 64) return 2.5;
        return 1.5;
    }

    private clampInput(input: HTMLInputElement, fallback: number) {
        const min = Number(input.min);
        const max = Number(input.max);
        const rawValue = Number(input.value);
        const value = Number.isFinite(rawValue) ? Math.floor(rawValue) : fallback;
        return Math.min(max, Math.max(min, value));
    }

    private resizeFrames(frames: number[][][], width: number, height: number) {
        const sourceFrames = frames.length ? frames : [this.createEmptyFrame(this.imgWidth, this.imgHeight)];
        return sourceFrames.map(frame => {
            const nextFrame: number[][] = [];
            for (let y = 0; y < height; y++) {
                const row: number[] = [];
                for (let x = 0; x < width; x++) {
                    row.push(frame[y]?.[x] === 1 ? 1 : 0);
                }
                nextFrame.push(row);
            }
            return nextFrame;
        });
    }

    private createEmptyValue(config?: FieldU8g2AnimationFromJsonConfig): U8g2AnimationValue {
        const width = this.normalizeNumber(config?.width, DEFAULT_WIDTH, 1, 256);
        const height = this.normalizeNumber(config?.height, DEFAULT_HEIGHT, 1, 128);
        const fps = this.normalizeNumber(config?.fps, DEFAULT_FPS, 1, 60);
        const maxFrames = this.normalizeNumber(config?.maxFrames, DEFAULT_MAX_FRAMES, 1, 500);
        const threshold = this.normalizeNumber(config?.threshold, DEFAULT_THRESHOLD, 0, 255);
        return {
            width,
            height,
            fps,
            maxFrames,
            dither: !!config?.dither,
            threshold,
            frames: [this.createEmptyFrame(width, height)],
        };
    }

    private createEmptyFrame(width: number, height: number) {
        const frame: number[][] = [];
        for (let y = 0; y < height; y++) {
            frame.push(Array.from({ length: width }, () => 0));
        }
        return frame;
    }

    private normalizeValue(
        value?: U8g2AnimationValue | null,
        config?: FieldU8g2AnimationFromJsonConfig,
    ): U8g2AnimationValue {
        const fallback = this.createEmptyValue(config);
        if (!value || typeof value !== 'object') return fallback;

        const width = this.normalizeNumber(value.width, fallback.width, 1, 256);
        const height = this.normalizeNumber(value.height, fallback.height, 1, 128);
        const fps = this.normalizeNumber(value.fps, fallback.fps, 1, 60);
        const maxFrames = this.normalizeNumber(value.maxFrames, fallback.maxFrames, 1, 500);
        const dither = typeof value.dither === 'boolean' ? value.dither : fallback.dither;
        const threshold = this.normalizeNumber(value.threshold, fallback.threshold, 0, 255);
        const frames = this.isValidFrames(value.frames, width, height)
            ? value.frames.map(frame => frame.map(row => row.map(cell => cell === 1 ? 1 : 0)))
            : [this.createEmptyFrame(width, height)];

        return {
            width,
            height,
            fps,
            maxFrames,
            dither,
            threshold,
            frames,
            sourceName: value.sourceName,
            sourceType: value.sourceType,
            sourcePath: value.sourcePath,
        };
    }

    private normalizeNumber(value: unknown, fallback: number, min: number, max: number) {
        const numberValue = Number(value);
        if (!Number.isFinite(numberValue)) return fallback;
        return Math.min(max, Math.max(min, Math.floor(numberValue)));
    }

    private isValidFrames(frames: unknown, width: number, height: number): frames is number[][][] {
        if (!Array.isArray(frames) || frames.length === 0) return false;
        return frames.every(frame => {
            if (!Array.isArray(frame) || frame.length !== height) return false;
            return frame.every(row => (
                Array.isArray(row)
                && row.length === width
                && row.every(cell => cell === 0 || cell === 1)
            ));
        });
    }

    private cloneValue(value: U8g2AnimationValue | null): U8g2AnimationValue {
        return this.normalizeValue(value);
    }

    private valuesEqual(left: U8g2AnimationValue | null, right: U8g2AnimationValue | null) {
        return JSON.stringify(left) === JSON.stringify(right);
    }

    private rerenderSourceBlock() {
        const sourceBlock = this.getSourceBlock();
        if (sourceBlock instanceof Blockly.BlockSvg && sourceBlock.rendered) {
            sourceBlock.render();
        }
    }

    private rerenderSourceBlockAfterResize() {
        this.rerenderSourceBlock();
        if (Blockly.DropDownDiv.getOwner() === this) {
            Blockly.DropDownDiv.showPositionedByField(
                this,
                this.dropdownDispose.bind(this),
            );
        }
    }

    private dropdownDispose() {
        this.clearSourceRedecodeTimer();
        this.terminateWorker();

        if (
            this.getSourceBlock() &&
            this.initialValue !== null &&
            !this.valuesEqual(this.initialValue, this.getValue())
        ) {
            Blockly.Events.fire(
                new (Blockly.Events.get(Blockly.Events.BLOCK_CHANGE))(
                    this.sourceBlock_,
                    'field',
                    this.name || null,
                    this.initialValue,
                    this.getValue(),
                ),
            );
            this.rerenderSourceBlock();
        }

        for (const event of this.boundEvents) {
            Blockly.browserEvents.unbind(event);
        }
        this.boundEvents.length = 0;
        this.frameStrip = null;
        this.statusElement = null;
        this.fileInput = null;
        this.widthInput = null;
        this.heightInput = null;
        this.fpsInput = null;
        this.maxFramesInput = null;
        this.thresholdInput = null;
        this.ditherInput = null;
        this.thresholdValueControl = null;
        this.thresholdValueInput = null;
        this.initialValue = null;

        Blockly.DropDownDiv.getContentDiv().classList.remove('contains-u8g2-animation-editor');
    }

    private terminateWorker() {
        if (this.decodeWorker) {
            this.decodeWorker.terminate();
            this.decodeWorker = null;
        }
    }

    private createElementWithClassname(elementType: string, className: string) {
        const newElement = document.createElement(elementType);
        newElement.className = className;
        return newElement;
    }

    private bindEvent(
        element: EventTarget,
        eventName: string,
        callback: (event: Event) => void,
    ) {
        this.boundEvents.push(
            Blockly.browserEvents.bind(element, eventName, this, callback),
        );
    }

    private hexToRgb(hex: string): { r: number; g: number; b: number } {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        return result ? {
            r: parseInt(result[1], 16),
            g: parseInt(result[2], 16),
            b: parseInt(result[3], 16),
        } : { r: 0, g: 0, b: 0 };
    }
}

Blockly.fieldRegistry.register('field_u8g2_animation', FieldU8g2Animation);

Blockly.Css.register(`
.u8g2AnimationEditor {
  align-items: stretch;
  background: var(--u8g2-panel-bg);
  color: var(--u8g2-text-primary);
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-width: 600px;
  padding: 5px 10px;
}
.u8g2AnimationToolbar {
  align-items: flex-start;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: space-between;
}
.u8g2AnimationControlGroup,
.u8g2AnimationButtonGroup {
  align-items: center;
  display: inline-flex;
  flex-wrap: wrap;
  gap: 6px;
}
.u8g2AnimationNumberControl {
  align-items: center;
  display: inline-flex;
  gap: 4px;
}
.u8g2AnimationModeControl {
  align-items: center;
  display: inline-flex;
  gap: 4px;
}
.u8g2AnimationThresholdValueControl {
  align-items: center;
  display: inline-flex;
}
.u8g2AnimationNumberControl span,
.u8g2AnimationModeControl span {
  color: var(--u8g2-text-primary);
  font-size: 12px;
  line-height: 1;
}
.u8g2AnimationNumberInput {
  background: var(--u8g2-input-bg);
  border: 1px solid var(--u8g2-input-border);
  border-radius: 4px;
  color: var(--u8g2-input-text);
  font-size: 12px;
  height: 26px;
  padding: 0 4px;
  text-align: center;
  width: 48px;
}
.u8g2AnimationButton {
  background: var(--u8g2-button-bg);
  border: 1px solid var(--u8g2-button-border);
  border-radius: 4px;
  color: var(--u8g2-button-text);
  cursor: pointer;
  font-size: 12px;
  height: 26px;
  margin: 0;
  padding: 0 10px;
}
.u8g2AnimationModeInput {
  accent-color: var(--u8g2-accent);
  height: 16px;
  margin: 0;
  width: 16px;
}
.u8g2AnimationThresholdValueInput {
  background: var(--u8g2-input-bg);
  border: 1px solid var(--u8g2-input-border);
  border-radius: 4px;
  color: var(--u8g2-input-text);
  font-size: 12px;
  height: 26px;
  padding: 0 4px;
  text-align: center;
  width: 48px;
}
.u8g2AnimationButton:hover {
  background: var(--u8g2-button-hover-bg);
  border-color: var(--u8g2-button-hover-border);
}
.u8g2AnimationStatus {
  color: var(--u8g2-text-secondary);
  font-size: 12px;
  line-height: 1.4;
  min-height: 18px;
}
.u8g2AnimationStatus.is-error {
  color: var(--u8g2-error-text);
}
.u8g2AnimationFrameStrip {
  align-items: flex-start;
  background: var(--u8g2-canvas-shell-bg);
  border: 1px solid var(--u8g2-border-strong);
  border-radius: 4px;
  display: flex;
  gap: 8px;
  max-height: 360px;
  max-width: 600px;
  overflow: auto;
  padding: 8px;
  scrollbar-color: var(--u8g2-scrollbar-thumb) transparent;
  scrollbar-width: thin;
}
.u8g2AnimationFrameStrip::-webkit-scrollbar {
  height: 4px;
  width: 4px;
}
.u8g2AnimationFrameStrip::-webkit-scrollbar-track {
  background: transparent;
}
.u8g2AnimationFrameStrip::-webkit-scrollbar-thumb {
  background: var(--u8g2-scrollbar-thumb);
  border-radius: 2px;
}
.u8g2AnimationFrameStrip::-webkit-scrollbar-thumb:hover {
  background: var(--u8g2-scrollbar-thumb-hover);
}
.u8g2AnimationFrameItem {
  align-items: center;
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  gap: 4px;
}
.u8g2AnimationFrameItem span,
.u8g2AnimationEmpty {
  color: var(--u8g2-text-secondary);
  font-size: 12px;
}
.u8g2AnimationCanvas {
  background: var(--u8g2-canvas-bg);
  border: 1px solid var(--u8g2-canvas-border);
  display: block;
  image-rendering: pixelated;
}
.blocklyDropDownContent.contains-u8g2-animation-editor {
  --u8g2-panel-bg: #2a2a2a;
  --u8g2-canvas-shell-bg: #1b1b1b;
  --u8g2-canvas-bg: #151515;
  --u8g2-canvas-border: #444;
  --u8g2-text-primary: #e8e8e8;
  --u8g2-text-secondary: #cfcfcf;
  --u8g2-error-text: #ffb3b3;
  --u8g2-border-strong: #666;
  --u8g2-input-bg: #ffffff;
  --u8g2-input-border: #777;
  --u8g2-input-text: #222;
  --u8g2-button-bg: #333;
  --u8g2-button-border: #666;
  --u8g2-button-text: #fff;
  --u8g2-button-hover-bg: #444;
  --u8g2-button-hover-border: #888;
  --u8g2-accent: #4db6ac;
  --u8g2-scrollbar-thumb: #666;
  --u8g2-scrollbar-thumb-hover: #888;
  background: var(--u8g2-panel-bg);
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  max-height: none;
}
:root[data-theme='light'] .blocklyDropDownContent.contains-u8g2-animation-editor,
.llight .blocklyDropDownContent.contains-u8g2-animation-editor {
  --u8g2-panel-bg: var(--surface-raised, #ffffff);
  --u8g2-canvas-shell-bg: var(--surface-subtle, #eef2f7);
  --u8g2-canvas-bg: #ffffff;
  --u8g2-canvas-border: var(--border-strong, #c7d2e2);
  --u8g2-text-primary: var(--text-primary, #111827);
  --u8g2-text-secondary: var(--text-tertiary, #667085);
  --u8g2-error-text: #c2410c;
  --u8g2-border-strong: var(--border-strong, #c7d2e2);
  --u8g2-input-bg: var(--control-bg, #ffffff);
  --u8g2-input-border: var(--border-strong, #c7d2e2);
  --u8g2-input-text: var(--text-primary, #111827);
  --u8g2-button-bg: var(--surface-subtle, #e9eef7);
  --u8g2-button-border: var(--border-strong, #c7d2e2);
  --u8g2-button-text: var(--text-primary, #111827);
  --u8g2-button-hover-bg: var(--hover-bg, #edf2fb);
  --u8g2-button-hover-border: var(--accent, #4169e1);
  --u8g2-accent: var(--accent, #4169e1);
  --u8g2-scrollbar-thumb: var(--scrollbar-thumb, rgba(75, 91, 119, 0.3));
  --u8g2-scrollbar-thumb-hover: rgba(75, 91, 119, 0.48);
  box-shadow: var(--shadow-soft, 0 16px 38px rgba(59, 78, 116, 0.11));
}
`);
