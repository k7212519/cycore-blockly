import * as Blockly from "blockly";

const svgPaths = Blockly.utils.svgPaths;

export class ConstantProvider extends Blockly.blockRendering.ConstantProvider {

  constructor() {
    super();
    this.STATEMENT_BOTTOM_SPACER = -this.NOTCH_HEIGHT;
  }

  protected override makeNotch(): Blockly.blockRendering.Notch {
    const makeRoundedPath = (direction: 1 | -1) =>
      svgPaths.curve('c', [
        svgPaths.point(direction * this.NOTCH_WIDTH * 0.22, 0),
        svgPaths.point(
          direction * this.NOTCH_WIDTH * 0.28,
          this.NOTCH_HEIGHT,
        ),
        svgPaths.point(
          direction * this.NOTCH_WIDTH * 0.5,
          this.NOTCH_HEIGHT,
        ),
      ]) +
      svgPaths.curve('c', [
        svgPaths.point(direction * this.NOTCH_WIDTH * 0.22, 0),
        svgPaths.point(
          direction * this.NOTCH_WIDTH * 0.28,
          -this.NOTCH_HEIGHT,
        ),
        svgPaths.point(
          direction * this.NOTCH_WIDTH * 0.5,
          -this.NOTCH_HEIGHT,
        ),
      ]);

    return {
      type: this.SHAPES['NOTCH'],
      width: this.NOTCH_WIDTH,
      height: this.NOTCH_HEIGHT,
      pathLeft: makeRoundedPath(1),
      pathRight: makeRoundedPath(-1),
    };
  }

  override makeStartHat(): Blockly.blockRendering.StartHat {
    const height = this.START_HAT_HEIGHT;
    const width = this.START_HAT_WIDTH;

    const mainPath = svgPaths.curve('c', [
      svgPaths.point(30, -height),
      svgPaths.point(70, -height),
      svgPaths.point(width, 0),
    ]);
    return { height: 0, width, path: mainPath };
  }
}
