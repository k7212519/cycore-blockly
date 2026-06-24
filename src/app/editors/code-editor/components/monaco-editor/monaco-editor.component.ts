import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output, SimpleChanges, ViewChild, OnDestroy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NzCodeEditorModule, NzCodeEditorComponent } from 'ng-zorro-antd/code-editor';
import { NzMessageService } from 'ng-zorro-antd/message';
import { Subject, takeUntil } from 'rxjs';
import { ThemeService } from '../../../../services/theme.service';
import { MonacoLoaderService } from '../../../../services/monaco-loader.service';
import { ConfigService } from '../../../../services/config.service';

@Component({
  selector: 'app-monaco-editor',
  imports: [
    NzCodeEditorModule,
    CommonModule,
    FormsModule
  ],
  templateUrl: './monaco-editor.component.html',
  styleUrl: './monaco-editor.component.scss'
})
export class MonacoEditorComponent implements OnDestroy {

  @ViewChild(NzCodeEditorComponent) codeEditor: NzCodeEditorComponent;

  @Input() options: any = {
    language: 'cpp',
    theme: 'vs-dark',
    lineNumbers: 'on',
    automaticLayout: true
  }

  @Input() code = '';
  @Input() filePath = ''; // 当前文件路径

  @Output() codeChange = new EventEmitter<string>();
  @Output() openFileRequest = new EventEmitter<{ filePath: string, position: any }>();
  @Output() editorShortcut = new EventEmitter<'save' | 'close'>();

  @Input() sdkPath: string;
  @Input() librariesPath: string;

  private disposables: any[] = [];
  private destroy$ = new Subject<void>();
  public monacoInstance: any;
  monacoReady = false;
  readonly defaultFontSize = 14;
  readonly minFontSize = 10;
  readonly maxFontSize = 32;

  constructor(
    private message: NzMessageService,
    private themeService: ThemeService,
    private monacoLoader: MonacoLoaderService,
    private configService: ConfigService
  ) {
    this.themeService.theme$
      .pipe(takeUntil(this.destroy$))
      .subscribe((theme) => this.applyTheme(theme));
  }

  async ngOnInit() {
    this.applySavedEditorOptions();
    await this.monacoLoader.load();
    this.monacoReady = true;
  }

  ngAfterViewInit() {
  }

  ngOnChanges(changes: SimpleChanges): void {
  }

  ngOnDestroy() {
    this.disposables.forEach(d => d.dispose());
    this.destroy$.next();
    this.destroy$.complete();
  }

  onCodeChange(newCode: string): void {
    this.codeChange.emit(newCode);
  }

  editorInitialized(editor: any): void {
    this.monacoInstance = editor;

    if (editor) {
      editor.updateOptions({ fontSize: this.editorFontSize });
      // 添加自定义右键菜单项
      this.setupContextMenu(editor);
      this.registerEditorCommands(editor);
    }
  }

  private registerEditorCommands(editor: any): void {
    const monaco = (window as any).monaco;
    if (!monaco?.KeyMod || !monaco?.KeyCode || !editor?.addAction) {
      return;
    }

    const KeyMod = monaco.KeyMod;
    const KeyCode = monaco.KeyCode;
    this.disposables.push(
      editor.addAction({
        id: 'cycore.editor.save',
        label: '保存当前文件',
        keybindings: [KeyMod.CtrlCmd | KeyCode.KeyS],
        contextMenuGroupId: 'navigation',
        contextMenuOrder: 1,
        run: () => this.editorShortcut.emit('save')
      }),
      editor.addAction({
        id: 'cycore.editor.closeTab',
        label: '关闭当前标签页',
        keybindings: [KeyMod.CtrlCmd | KeyCode.KeyW],
        contextMenuGroupId: 'navigation',
        contextMenuOrder: 2,
        run: () => this.editorShortcut.emit('close')
      }),
      editor.addAction({
        id: 'cycore.editor.fontZoomIn',
        label: '放大编辑器字体',
        keybindings: [
          KeyMod.CtrlCmd | KeyCode.Equal,
          KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Equal,
          KeyMod.CtrlCmd | KeyCode.NumpadAdd
        ],
        contextMenuGroupId: '1_modification',
        contextMenuOrder: 10,
        run: () => this.increaseFontSize()
      }),
      editor.addAction({
        id: 'cycore.editor.fontZoomOut',
        label: '缩小编辑器字体',
        keybindings: [
          KeyMod.CtrlCmd | KeyCode.Minus,
          KeyMod.CtrlCmd | KeyCode.NumpadSubtract
        ],
        contextMenuGroupId: '1_modification',
        contextMenuOrder: 11,
        run: () => this.decreaseFontSize()
      }),
      editor.addAction({
        id: 'cycore.editor.fontReset',
        label: '重置编辑器字体',
        keybindings: [
          KeyMod.CtrlCmd | KeyCode.Digit0,
          KeyMod.CtrlCmd | KeyCode.Numpad0
        ],
        contextMenuGroupId: '1_modification',
        contextMenuOrder: 12,
        run: () => this.resetFontSize()
      })
    );
  }

  private applyTheme(theme: 'dark' | 'light'): void {
    const monacoTheme = theme === 'light' ? 'vs' : 'vs-dark';
    this.options = { ...this.options, theme: monacoTheme };
    (window as any).monaco?.editor?.setTheme(monacoTheme);
  }

  get editorFontSize(): number {
    const fontSize = Number(this.configService.data?.codeEditor?.fontSize);
    return this.clampFontSize(Number.isFinite(fontSize) ? fontSize : this.defaultFontSize);
  }

  increaseFontSize(): void {
    this.setFontSize(this.editorFontSize + 1);
  }

  decreaseFontSize(): void {
    this.setFontSize(this.editorFontSize - 1);
  }

  resetFontSize(): void {
    this.setFontSize(this.defaultFontSize);
  }

  private applySavedEditorOptions(): void {
    this.options = {
      ...this.options,
      fontSize: this.editorFontSize
    };
  }

  private setFontSize(nextFontSize: number): void {
    const fontSize = this.clampFontSize(nextFontSize);
    this.configService.data.codeEditor = {
      ...(this.configService.data.codeEditor || {}),
      fontSize
    };
    this.configService.save();
    this.options = {
      ...this.options,
      fontSize
    };
    this.monacoInstance?.updateOptions?.({ fontSize });
  }

  private clampFontSize(fontSize: number): number {
    return Math.min(this.maxFontSize, Math.max(this.minFontSize, Math.round(fontSize)));
  }

  /**
   * 设置自定义右键菜单
   */
  private setupContextMenu(editor: any): void {
    if (!this.monacoInstance) return;
  }

  /**
   * 获取编辑器的视图状态（包含滚动位置、光标位置等）
   */
  public getViewState(): any {
    if (this.monacoInstance && this.monacoInstance.getModel()) {
      try {
        const viewState = this.monacoInstance.saveViewState();
        // console.log('获取视图状态成功:', viewState);
        return viewState;
      } catch (error) {
        console.warn('获取视图状态失败:', error);
        return null;
      }
    } else {
      console.warn('编辑器实例或模型未准备好，无法获取视图状态');
      return null;
    }
  }

  /**
   * 恢复编辑器的视图状态
   */
  public restoreViewState(viewState: any): void {
    if (!viewState) return;
    if (this.monacoInstance && this.monacoInstance.getModel()) {
      try {
        this.monacoInstance.restoreViewState(viewState);
        console.log('视图状态恢复成功');
      } catch (error) {
        console.warn('恢复视图状态失败:', error);
      }
    } else {
      console.warn('编辑器实例或模型未准备好，无法恢复视图状态');
    }
  }

  /**
   * 安全地恢复编辑器状态，会等待编辑器准备就绪
   */
  public async restoreViewStateSafely(viewState: any): Promise<boolean> {
    if (!viewState) return false;

    return new Promise((resolve) => {
      const maxAttempts = 20;
      let attempts = 0;

      const tryRestore = () => {
        if (this.monacoInstance && this.monacoInstance.getModel()) {
          try {
            this.monacoInstance.restoreViewState(viewState);
            console.log('视图状态安全恢复成功');
            resolve(true);
            return;
          } catch (error) {
            console.warn('恢复视图状态失败:', error);
          }
        }

        attempts++;
        if (attempts < maxAttempts) {
          setTimeout(tryRestore, 50);
        } else {
          console.warn('视图状态恢复超时');
          resolve(false);
        }
      };

      tryRestore();
    });
  }

}
