import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit } from '@angular/core';
import { NzMessageService } from 'ng-zorro-antd/message';
import * as Blockly from 'blockly';
import { Subscription } from 'rxjs';
import { ProjectService, ServerBlocklyLibraryResource } from '../../../../services/project.service';
import { LibManagerComponent } from '../../../blockly-editor/components/lib-manager/lib-manager.component';
import { BlocklyService } from '../../../blockly-editor/services/blockly.service';
import { processI18n, processJsonVar, processToolboxI18n } from '../../../blockly-editor/components/blockly/abf';
import { arduinoGenerator } from '../../../blockly-editor/components/blockly/generators/arduino/arduino';

interface ProfessionalSnippet {
  id: string;
  type: string;
  title: string;
  body: string;
  available: boolean;
  tooltip?: string;
}

interface ProfessionalCategory {
  name: string;
  icon?: string;
  expanded: boolean;
  snippets: ProfessionalSnippet[];
}

@Component({
  selector: 'app-professional-library-reference',
  imports: [CommonModule, LibManagerComponent],
  templateUrl: './professional-library-reference.component.html',
  styleUrl: './professional-library-reference.component.scss'
})
export class ProfessionalLibraryReferenceComponent implements OnInit, OnDestroy {
  categories: ProfessionalCategory[] = [];
  loading = false;
  error = '';
  showLibraryManager = false;
  private librariesChangedSubscription?: Subscription;

  constructor(
    private projectService: ProjectService,
    private blocklyService: BlocklyService,
    private message: NzMessageService
  ) { }

  async ngOnInit(): Promise<void> {
    this.librariesChangedSubscription = this.projectService.serverProjectLibrariesChanged$.subscribe(projectId => {
      if (projectId === this.projectService.currentProjectId) {
        void this.loadReferences();
      }
    });
    await this.loadReferences();
  }

  ngOnDestroy(): void {
    this.librariesChangedSubscription?.unsubscribe();
    document.body.classList.remove('lib-manager-overlay-open');
  }

  async loadReferences(): Promise<void> {
    if (!this.projectService.currentProjectId) {
      this.categories = [];
      return;
    }

    this.loading = true;
    this.error = '';
    try {
      const dependencies = (this.projectService.currentPackageData as any)?.dependencies || {};
      const libraryNames = Object.keys(dependencies)
        .filter(name => name.startsWith('@aily-project/lib-'));
      const resources = await this.projectService.getServerBlocklyLibraryResources(
        libraryNames,
        dependencies
      );

      this.blocklyService.boardConfig = this.projectService.currentBoardConfig || {};
      await this.blocklyService.loadLibrariesForCodeGeneration(libraryNames, this.projectService.currentProjectPath);
      this.categories = this.buildCategories(this.sortResourcesByLibraryOrder(resources, libraryNames));
    } catch (error: any) {
      console.error('加载专业模式库参考失败:', error);
      this.error = error?.message || '加载库参考失败';
    } finally {
      this.loading = false;
    }
  }

  openLibraryManager(): void {
    this.showLibraryManager = true;
    document.body.classList.add('lib-manager-overlay-open');
  }

  closeLibraryManager(): void {
    this.showLibraryManager = false;
    document.body.classList.remove('lib-manager-overlay-open');
    void this.loadReferences();
  }

  onLibrariesChanged(): void {
    void this.loadReferences();
  }

  toggle(category: ProfessionalCategory): void {
    category.expanded = !category.expanded;
  }

  async copy(snippet: ProfessionalSnippet, event: Event): Promise<void> {
    event.stopPropagation();
    if (!snippet.available) {
      return;
    }
    event.preventDefault();
    try {
      await navigator.clipboard.writeText(snippet.body);
      this.message.success('已复制 Arduino 代码');
    } catch (error) {
      console.warn('复制失败:', error);
      this.message.warning('复制失败，请手动选择文本');
    }
  }

  private buildCategories(resources: ServerBlocklyLibraryResource[]): ProfessionalCategory[] {
    const categories: ProfessionalCategory[] = [];

    for (const resource of resources || []) {
      if (!resource?.blockJson || !resource?.toolboxJson) {
        continue;
      }

      try {
        const i18nData = resource.i18nJson ? JSON.parse(resource.i18nJson) : null;
        const rawBlocks = JSON.parse(resource.blockJson);
        const localizedBlocks = i18nData ? processI18n(rawBlocks, i18nData) : rawBlocks;
        const blocks = processJsonVar(localizedBlocks, this.projectService.currentBoardConfig || {});
        const blockMap = new Map<string, any>();
        blocks.forEach((block: any) => {
          if (block?.type) {
            blockMap.set(block.type, block);
          }
        });

        const rawToolbox = i18nData
          ? processToolboxI18n(JSON.parse(resource.toolboxJson), i18nData)
          : JSON.parse(resource.toolboxJson);
        const toolbox = processJsonVar(rawToolbox, this.projectService.currentBoardConfig || {});
        const snippets = this.snippetsFromToolbox(toolbox, blockMap);
        if (snippets.length > 0) {
          categories.push({
            name: toolbox.name || this.libraryDisplayName(resource.name),
            icon: toolbox.icon,
            expanded: false,
            snippets
          });
        }
      } catch (error) {
        console.warn('解析库参考失败:', resource.name, error);
      }
    }

    return categories;
  }

  private sortResourcesByLibraryOrder(
    resources: ServerBlocklyLibraryResource[],
    libraryNames: string[]
  ): ServerBlocklyLibraryResource[] {
    const order = new Map(libraryNames.map((name, index) => [name, index]));
    return [...(resources || [])].sort((left, right) => {
      const leftIndex = order.get(left.name) ?? Number.MAX_SAFE_INTEGER;
      const rightIndex = order.get(right.name) ?? Number.MAX_SAFE_INTEGER;
      return leftIndex - rightIndex;
    });
  }

  private snippetsFromToolbox(toolbox: any, blockMap: Map<string, any>): ProfessionalSnippet[] {
    const snippets: ProfessionalSnippet[] = [];
    const includeLines = new Set<string>();
    let sequence = 0;
    const visit = (items: any[]) => {
      for (const item of items || []) {
        if (item?.kind === 'block' && item.type) {
          const block = blockMap.get(item.type);
          snippets.push(this.blockToSnippet(item, block, sequence++, includeLines));
        }
        if (Array.isArray(item?.contents)) {
          visit(item.contents);
        }
      }
    };
    visit(toolbox?.contents || []);
    if (includeLines.size > 0) {
      snippets.unshift({
        id: `${toolbox?.name || 'library'}-headers`,
        type: 'library_headers',
        title: '头文件',
        body: Array.from(includeLines).join('\n'),
        available: true,
        tooltip: '使用该库代码前需要放在文件顶部的 #include 语句'
      });
    }
    return snippets;
  }

  private blockToSnippet(
    toolboxBlock: any,
    blockDefinition: any,
    sequence: number,
    includeLines?: Set<string>
  ): ProfessionalSnippet {
    const type = toolboxBlock.type;
    const title = this.blockTitle(type, blockDefinition);
    const tooltip = typeof blockDefinition?.tooltip === 'string' ? blockDefinition.tooltip : '';
    const unavailable = (body = '当前块无法生成 Arduino 代码'): ProfessionalSnippet => ({
      id: `${type}-${sequence}`,
      type,
      title,
      tooltip,
      body,
      available: false
    });

    if (!Blockly.Blocks[type] || typeof arduinoGenerator.forBlock[type] !== 'function') {
      return unavailable();
    }

    const workspace = new Blockly.Workspace();
    const eventsWereEnabled = Blockly.Events.isEnabled();
    try {
      Blockly.Events.disable();
      const state = this.toolboxBlockState(toolboxBlock);
      const block = Blockly.serialization.blocks.append(state, workspace);
      arduinoGenerator.init(workspace);
      const generated = arduinoGenerator.blockToCode(block, true);
      this.collectGeneratorIncludes().forEach(line => includeLines?.add(line));
      const directCode = (Array.isArray(generated) ? generated[0] : generated || '').trim();
      const fallbackCode = this.actualFallbackCode(block.id);
      const body = directCode || fallbackCode;

      if (!body) {
        return unavailable();
      }
      return {
        id: `${type}-${sequence}`,
        type,
        title,
        tooltip,
        body,
        available: true
      };
    } catch (error) {
      console.warn(`生成块代码失败: ${type}`, error);
      return unavailable();
    } finally {
      try {
        arduinoGenerator.finish('');
      } catch {
        // The next block starts from a fresh generator state.
      }
      workspace.dispose();
      if (eventsWereEnabled) {
        Blockly.Events.enable();
      }
    }
  }

  private collectGeneratorIncludes(): string[] {
    const libraries = (arduinoGenerator as any).codeDict?.libraries || {};
    return Object.values(libraries)
      .map(code => String(code || '').trim())
      .filter(code => /^#include\b/.test(code));
  }

  private toolboxBlockState(toolboxBlock: any): Blockly.serialization.blocks.State {
    const state = JSON.parse(JSON.stringify(toolboxBlock));
    delete state.kind;
    delete state.gap;
    return state as Blockly.serialization.blocks.State;
  }

  private actualFallbackCode(blockId: string): string {
    const allowedSections = new Set([
      'variables',
      'objects',
      'functions',
      'setups_begin',
      'setups',
      'setups_end',
      'loops_begin',
      'loops',
      'loops_end'
    ]);
    const fragments = arduinoGenerator.blockCodeFragments.get(blockId) || [];
    const uniqueCode = Array.from(new Set(
      fragments
        .filter(fragment => allowedSections.has(fragment.section))
        .map(fragment => fragment.code?.trim())
        .filter((code): code is string => !!code)
    ));
    return uniqueCode.join('\n');
  }

  private blockTitle(type: string, block: any): string {
    const messages: string[] = [];
    let index = 0;
    while (block?.[`message${index}`] !== undefined) {
      const message = String(block[`message${index}`] || '')
        .replace(/%\d+/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (message) {
        messages.push(message);
      }
      index++;
    }
    return messages.join(' / ') || type;
  }

  private libraryDisplayName(name: string): string {
    return (name || '').replace(/^@aily-project\/lib-/, '');
  }
}
