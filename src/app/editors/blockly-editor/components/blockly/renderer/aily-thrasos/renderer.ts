import * as Blockly from "blockly";
import { ConstantProvider } from "./constant";
import { Drawer } from "./drawer";
import { RenderInfo } from "./info";
import { addAilyIconToBlock, getBlockDefinition } from "../aily-icon/acon";

type BlockSvg = Blockly.BlockSvg;

export class Renderer extends Blockly.thrasos.Renderer {
  constructor(name: string) {
    super(name);
  }

  override makeConstants_() {
    return new ConstantProvider();
  }

  override makeRenderInfo_(block: any): Blockly.thrasos.RenderInfo {
    let acon = getBlockDefinition(block.type);
    if (block && acon) {
      if (acon && typeof acon === "string" && !acon.includes("fa-")) {
        acon = `fa-solid ${acon}`;
      }
      addAilyIconToBlock(block, acon);
    }
    return new RenderInfo(this, block);
  }

  protected override makeDrawer_(
    block: BlockSvg,
    info: Blockly.blockRendering.RenderInfo,
  ): Blockly.blockRendering.Drawer {
    return new Drawer(block, info as Blockly.thrasos.RenderInfo);
  }
}

Blockly.blockRendering.register("aily-thrasos", Renderer);
