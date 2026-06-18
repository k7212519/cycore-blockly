import { Injectable } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import * as Blockly from 'blockly';
import { ProjectService } from '../../../services/project.service';
import { downloadBlob } from '../../../utils/img.utils';
import { BlocklyService } from './blockly.service';

interface EmbeddedFont {
  family: string;
  weight: string;
  assetPath: string;
}

export interface BlocklySvgExportResult {
  fileName: string;
  width: number;
  height: number;
}

@Injectable({
  providedIn: 'root',
})
export class BlocklySvgExportService {
  private readonly svgNamespace = 'http://www.w3.org/2000/svg';
  private readonly xlinkNamespace = 'http://www.w3.org/1999/xlink';
  private readonly exportPadding = 24;
  private readonly computedStyleProperties = [
    'color',
    'fill',
    'fill-opacity',
    'fill-rule',
    'stroke',
    'stroke-width',
    'stroke-opacity',
    'stroke-linecap',
    'stroke-linejoin',
    'stroke-dasharray',
    'opacity',
    'filter',
    'font-family',
    'font-size',
    'font-style',
    'font-weight',
    'letter-spacing',
    'text-anchor',
    'dominant-baseline',
    'paint-order',
    'shape-rendering',
    'visibility',
  ];

  constructor(
    private readonly blocklyService: BlocklyService,
    private readonly projectService: ProjectService,
    private readonly translate: TranslateService,
  ) {}

  async exportAndDownload(): Promise<BlocklySvgExportResult> {
    const workspace = this.blocklyService.workspace;
    if (!workspace || workspace.getTopBlocks(false).length === 0) {
      throw new Error(this.translate.instant('BLOCKLY_EDITOR.EXPORT_SVG_EMPTY'));
    }

    await Blockly.renderManagement.finishQueuedRenders();

    const svg = await this.createStandaloneSvg(workspace);
    const content =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      new XMLSerializer().serializeToString(svg);
    const fileName = `${this.getSafeProjectName()}-blocks.svg`;

    downloadBlob(
      new Blob([content], { type: 'image/svg+xml;charset=utf-8' }),
      fileName,
    );

    const viewBox = svg.viewBox.baseVal;
    return {
      fileName,
      width: viewBox.width,
      height: viewBox.height,
    };
  }

  private async createStandaloneSvg(
    workspace: Blockly.WorkspaceSvg,
  ): Promise<SVGSVGElement> {
    const sourceCanvas = workspace.getCanvas();
    const clonedCanvas = sourceCanvas.cloneNode(true) as SVGGElement;
    const bounds = workspace.getBlocksBoundingBox();
    const width = Math.max(1, bounds.right - bounds.left + this.exportPadding * 2);
    const height = Math.max(1, bounds.bottom - bounds.top + this.exportPadding * 2);
    const viewBoxX = bounds.left - this.exportPadding;
    const viewBoxY = bounds.top - this.exportPadding;

    clonedCanvas.removeAttribute('transform');

    const removedSelectionClasses = this.removeTransientSourceClasses(sourceCanvas);
    try {
      this.copyComputedStyles(sourceCanvas, clonedCanvas);
      this.replaceFontAwesomeForeignObjects(sourceCanvas, clonedCanvas);
      this.normalizeTextFonts(clonedCanvas);
    } finally {
      removedSelectionClasses.forEach(({ element, className }) => {
        element.classList.add(className);
      });
    }

    clonedCanvas.querySelectorAll('.blocklySelected').forEach((element) => {
      element.classList.remove('blocklySelected');
    });
    clonedCanvas.querySelectorAll('.blocklyDragging, .blocklyInsertionMarker').forEach(
      (element) => element.remove(),
    );

    await this.inlineImageResources(clonedCanvas);

    const svg = document.createElementNS(this.svgNamespace, 'svg');
    svg.setAttribute('xmlns', this.svgNamespace);
    svg.setAttribute('xmlns:xlink', this.xlinkNamespace);
    svg.setAttribute('version', '1.1');
    svg.setAttribute('width', this.formatNumber(width));
    svg.setAttribute('height', this.formatNumber(height));
    svg.setAttribute(
      'viewBox',
      [
        this.formatNumber(viewBoxX),
        this.formatNumber(viewBoxY),
        this.formatNumber(width),
        this.formatNumber(height),
      ].join(' '),
    );
    svg.setAttribute('role', 'img');

    const title = document.createElementNS(this.svgNamespace, 'title');
    title.textContent = `${this.getProjectDisplayName()} Blockly`;
    svg.appendChild(title);

    const definitions = await this.createEmbeddedFontDefinitions(clonedCanvas);
    if (definitions) {
      svg.appendChild(definitions);
    }

    svg.appendChild(clonedCanvas);
    return svg;
  }

  private removeTransientSourceClasses(
    sourceCanvas: SVGElement,
  ): Array<{ element: Element; className: string }> {
    const removed: Array<{ element: Element; className: string }> = [];
    const transientClasses = [
      'blocklySelected',
      'blocklyDragging',
      'blocklyInsertionMarker',
    ];

    sourceCanvas.querySelectorAll(transientClasses.map((name) => `.${name}`).join(',')).forEach(
      (element) => {
        transientClasses.forEach((className) => {
          if (element.classList.contains(className)) {
            element.classList.remove(className);
            removed.push({ element, className });
          }
        });
      },
    );

    return removed;
  }

  private copyComputedStyles(sourceRoot: Element, cloneRoot: Element): void {
    const sourceElements = [sourceRoot, ...Array.from(sourceRoot.querySelectorAll('*'))];
    const cloneElements = [cloneRoot, ...Array.from(cloneRoot.querySelectorAll('*'))];
    const count = Math.min(sourceElements.length, cloneElements.length);

    for (let index = 0; index < count; index++) {
      const source = sourceElements[index];
      const clone = cloneElements[index];
      if (!(clone instanceof SVGElement) && !(clone instanceof HTMLElement)) {
        continue;
      }

      const computed = getComputedStyle(source);
      this.computedStyleProperties.forEach((property) => {
        const value = computed.getPropertyValue(property);
        if (value && value !== 'none' && value !== 'normal') {
          clone.style.setProperty(property, value);
        }
      });
    }
  }

  private replaceFontAwesomeForeignObjects(
    sourceCanvas: SVGElement,
    clonedCanvas: SVGElement,
  ): void {
    const sourceForeignObjects = Array.from(
      sourceCanvas.querySelectorAll('foreignObject'),
    );
    const clonedForeignObjects = Array.from(
      clonedCanvas.querySelectorAll('foreignObject'),
    );

    clonedForeignObjects.forEach((clonedForeignObject, index) => {
      const sourceForeignObject = sourceForeignObjects[index];
      const icon = sourceForeignObject?.querySelector('i');
      if (!icon || !this.isFontAwesomeIcon(icon)) {
        return;
      }

      const replacement = document.createElementNS(this.svgNamespace, 'g');
      const width = this.readNumericAttribute(clonedForeignObject, 'width', 16);
      const height = this.readNumericAttribute(clonedForeignObject, 'height', 16);
      const x = this.readNumericAttribute(clonedForeignObject, 'x', 0);
      const y = this.readNumericAttribute(clonedForeignObject, 'y', 0);
      const baseStyle = getComputedStyle(icon);
      const layers = [
        getComputedStyle(icon, '::before'),
        getComputedStyle(icon, '::after'),
      ];

      layers.forEach((layerStyle) => {
        const glyph = this.readPseudoElementContent(layerStyle.content);
        if (!glyph) return;

        const text = document.createElementNS(this.svgNamespace, 'text');
        const fontSize =
          Number.parseFloat(layerStyle.fontSize || baseStyle.fontSize) || height;
        text.setAttribute('x', this.formatNumber(x + width / 2));
        text.setAttribute('y', this.formatNumber(y + height / 2));
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('dominant-baseline', 'central');
        text.setAttribute('font-family', layerStyle.fontFamily || baseStyle.fontFamily);
        text.setAttribute('font-size', this.formatNumber(fontSize));
        text.setAttribute('font-style', layerStyle.fontStyle || baseStyle.fontStyle);
        text.setAttribute('font-weight', layerStyle.fontWeight || baseStyle.fontWeight);
        text.setAttribute('fill', layerStyle.color || baseStyle.color || '#000');
        if (layerStyle.opacity && layerStyle.opacity !== '1') {
          text.setAttribute('opacity', layerStyle.opacity);
        }
        text.textContent = glyph;
        replacement.appendChild(text);
      });

      if (replacement.childNodes.length > 0) {
        clonedForeignObject.replaceWith(replacement);
      }
    });
  }

  private async inlineImageResources(root: SVGElement): Promise<void> {
    const images = Array.from(root.querySelectorAll('image'));
    await Promise.all(
      images.map(async (image) => {
        const href =
          image.getAttribute('href') ||
          image.getAttributeNS(this.xlinkNamespace, 'href') ||
          image.getAttribute('xlink:href');
        if (!href || href.startsWith('data:')) return;

        const absoluteUrl = new URL(href, document.baseURI).href;
        try {
          const response = await fetch(absoluteUrl);
          if (!response.ok) {
            throw new Error(`${response.status} ${response.statusText}`);
          }
          const dataUrl = await this.blobToDataUrl(await response.blob());
          image.setAttribute('href', dataUrl);
          image.setAttributeNS(this.xlinkNamespace, 'xlink:href', dataUrl);
        } catch (error) {
          throw new Error(
            this.translate.instant('BLOCKLY_EDITOR.EXPORT_SVG_RESOURCE_FAILED', {
              resource: href,
            }),
            { cause: error },
          );
        }
      }),
    );
  }

  private async createEmbeddedFontDefinitions(
    root: SVGElement,
  ): Promise<SVGDefsElement | null> {
    const fonts = this.collectRequiredFonts(root);
    if (fonts.length === 0) return null;

    const rules: string[] = [];
    for (const font of fonts) {
      try {
        const dataUrl = await this.fetchAssetAsDataUrl(font.assetPath);
        rules.push(
          `@font-face{font-family:${JSON.stringify(font.family)};` +
          `font-style:normal;font-weight:${font.weight};` +
          `src:url(${JSON.stringify(dataUrl)}) format("woff2");}`,
        );
      } catch (error) {
        throw new Error(
          this.translate.instant('BLOCKLY_EDITOR.EXPORT_SVG_RESOURCE_FAILED', {
            resource: font.assetPath,
          }),
          { cause: error },
        );
      }
    }

    const definitions = document.createElementNS(this.svgNamespace, 'defs');
    const style = document.createElementNS(this.svgNamespace, 'style');
    style.setAttribute('type', 'text/css');
    style.textContent = rules.join('\n');
    definitions.appendChild(style);
    return definitions;
  }

  private collectRequiredFonts(root: SVGElement): EmbeddedFont[] {
    const required = new Map<string, EmbeddedFont>();

    root.querySelectorAll('text, tspan').forEach((element) => {
      const svgElement = element as SVGElement;
      const family = (element.getAttribute('font-family') || svgElement.style.fontFamily || '')
        .replace(/["']/g, '');
      const weight = element.getAttribute('font-weight') || svgElement.style.fontWeight || '400';
      const font = this.resolveFontAwesomeAsset(family, weight);
      if (font) {
        required.set(`${font.family}:${font.weight}`, font);
      }
    });

    return Array.from(required.values());
  }

  private normalizeTextFonts(root: SVGElement): void {
    root.querySelectorAll<SVGTextElement>('text, tspan').forEach((element) => {
      const family =
        element.getAttribute('font-family') ||
        element.style.fontFamily ||
        '';
      if (
        family.includes('MiSans') ||
        family.includes('FiraCode') ||
        family.trim() === ''
      ) {
        const fallback =
          'Arial, "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif';
        element.setAttribute('font-family', fallback);
        element.style.setProperty('font-family', fallback);
      }
    });
  }

  private resolveFontAwesomeAsset(
    familyValue: string,
    weightValue: string,
  ): EmbeddedFont | null {
    const family = familyValue.split(',')[0].trim();
    const numericWeight = this.normalizeFontWeight(weightValue);

    if (family.includes('Font Awesome 6 Brands')) {
      return {
        family: 'Font Awesome 6 Brands',
        weight: '400',
        assetPath: 'fonts/fontawesome6/webfonts/fa-brands-400.woff2',
      };
    }
    if (family.includes('Font Awesome 6 Duotone')) {
      return {
        family: 'Font Awesome 6 Duotone',
        weight: '900',
        assetPath: 'fonts/fontawesome6/webfonts/fa-duotone-900.woff2',
      };
    }
    if (family.includes('Font Awesome 6 Sharp')) {
      const sharpWeight = ['300', '400', '900'].includes(numericWeight)
        ? numericWeight
        : '900';
      const fileByWeight: Record<string, string> = {
        '300': 'fa-sharp-light-300.woff2',
        '400': 'fa-sharp-regular-400.woff2',
        '900': 'fa-sharp-solid-900.woff2',
      };
      return {
        family: 'Font Awesome 6 Sharp',
        weight: sharpWeight,
        assetPath: `fonts/fontawesome6/webfonts/${fileByWeight[sharpWeight]}`,
      };
    }
    if (family.includes('Font Awesome 6 Pro')) {
      const proWeight = ['100', '300', '400', '900'].includes(numericWeight)
        ? numericWeight
        : '900';
      const fileByWeight: Record<string, string> = {
        '100': 'fa-thin-100.woff2',
        '300': 'fa-light-300.woff2',
        '400': 'fa-regular-400.woff2',
        '900': 'fa-solid-900.woff2',
      };
      return {
        family: 'Font Awesome 6 Pro',
        weight: proWeight,
        assetPath: `fonts/fontawesome6/webfonts/${fileByWeight[proWeight]}`,
      };
    }
    return null;
  }

  private isFontAwesomeIcon(icon: Element): boolean {
    return Array.from(icon.classList).some(
      (className) =>
        className === 'fa' ||
        className === 'fas' ||
        className === 'far' ||
        className === 'fal' ||
        className === 'fat' ||
        className === 'fab' ||
        className.startsWith('fa-'),
    );
  }

  private readPseudoElementContent(content: string): string {
    if (!content || content === 'none' || content === 'normal') return '';
    let value = content.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value
      .replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_, codePoint) =>
        String.fromCodePoint(Number.parseInt(codePoint, 16)),
      )
      .replace(/\\(["'\\])/g, '$1');
  }

  private normalizeFontWeight(weight: string): string {
    const normalized = weight.trim().toLowerCase();
    if (normalized === 'normal') return '400';
    if (normalized === 'bold') return '700';
    const numeric = Number.parseInt(normalized, 10);
    return Number.isFinite(numeric) ? String(numeric) : '400';
  }

  private readNumericAttribute(
    element: Element,
    attribute: string,
    fallback: number,
  ): number {
    const value = Number.parseFloat(element.getAttribute(attribute) || '');
    return Number.isFinite(value) ? value : fallback;
  }

  private async fetchAssetAsDataUrl(assetPath: string): Promise<string> {
    const response = await fetch(new URL(assetPath, document.baseURI).href);
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }
    return this.blobToDataUrl(await response.blob());
  }

  private blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  private getProjectDisplayName(): string {
    const packageData = this.projectService.currentPackageData;
    return packageData?.nickname || packageData?.name || 'blockly';
  }

  private getSafeProjectName(): string {
    const normalized = this.getProjectDisplayName()
      .trim()
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[.-]+|[.-]+$/g, '');
    return normalized || 'blockly';
  }

  private formatNumber(value: number): string {
    return String(Math.round(value * 100) / 100);
  }
}
