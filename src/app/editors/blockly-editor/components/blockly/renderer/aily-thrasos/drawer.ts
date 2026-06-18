import * as Blockly from 'blockly';

const svgPaths = Blockly.utils.svgPaths;

type BlockSvg = Blockly.BlockSvg;
type RenderInfo = Blockly.thrasos.RenderInfo;
type Row = Blockly.blockRendering.Row;
type Notch = Blockly.blockRendering.Notch;

export class Drawer extends Blockly.blockRendering.Drawer {
  constructor(block: BlockSvg, info: RenderInfo) {
    super(block, info);
  }

  protected override drawStatementInput_(row: Row): void {
    const input = row.getLastInput();
    if (!input) {
      return;
    }

    const notch = input.shape as Notch;
    const notchLeft = input.xPos + input.notchOffset;
    const notchRight = notchLeft + notch.width;
    const innerCorner = this.constants_.INSIDE_CORNERS;
    const innerHeight = row.height - 2 * innerCorner.height;

    this.outlinePath_ +=
      svgPaths.lineOnAxis('H', notchRight) +
      notch.pathRight +
      svgPaths.lineOnAxis(
        'h',
        -(input.notchOffset - innerCorner.width),
      ) +
      innerCorner.pathTop +
      svgPaths.lineOnAxis('v', innerHeight) +
      innerCorner.pathBottom +
      svgPaths.lineOnAxis('H', notchLeft) +
      notch.pathLeft +
      svgPaths.lineOnAxis('H', row.xPos + row.width);

    this.positionStatementInputConnection_(row);
  }
}
