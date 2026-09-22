import * as Blockly from 'blockly/core';
import { CycoreVideoConverter, CycoreVideoValue } from './cycore-video-converter';

declare global { interface Window { cycoreVideoConversions?: Set<object>; } }
export class FieldCycoreVideo extends Blockly.Field<string> {
  private converter?: CycoreVideoConverter;
  private previewUrl?: string;
  private generation=0;
  constructor(value: string | typeof Blockly.Field.SKIP_SETUP, validator?: Blockly.FieldValidator<string>, config?: Blockly.FieldConfig) {
    super(value,validator,config);this.SERIALIZABLE=true;
  }
  static override fromJson(options:any):FieldCycoreVideo {return new this(options.value||'',undefined,options);}
  override getText():string {
    try {const v=JSON.parse(this.getValue()) as CycoreVideoValue;return `${v.fileName} · ${(v.durationMs/1000).toFixed(1)}s · ${(v.base64.length*0.75/1024).toFixed(0)} KiB`;}
    catch{return '选择视频（≤5 MiB）';}
  }
  private cancel():void {
    this.generation++;this.converter?.cancel();this.converter=undefined;
    window.cycoreVideoConversions?.delete(this);
  }
  override dispose():void {this.cancel();this.releasePreview();super.dispose();}
  private releasePreview():void {if(this.previewUrl) URL.revokeObjectURL(this.previewUrl);this.previewUrl=undefined;}
  protected override showEditor_():void {
    const root=document.createElement('div');root.style.cssText='padding:16px;max-width:390px;display:grid;gap:10px;color:#222;background:white';
    const hint=document.createElement('div');hint.textContent='本地转换 · 原视频 ≤5 MiB · 10帧/秒 · 单声道。转换结果随项目保存。';root.append(hint);
    const select=document.createElement('select');
    for(const size of ['240×240','240×320','320×240']) {const o=document.createElement('option');o.value=size;o.textContent=size;select.append(o);}
    try {const v=JSON.parse(this.getValue());select.value=`${v.width}×${v.height}`;}catch{}
    root.append(select);
    const preview=document.createElement('video');preview.controls=true;preview.style.cssText='width:100%;max-height:220px;background:#111';root.append(preview);
    const status=document.createElement('div');status.textContent=this.getText();root.append(status);
    const input=document.createElement('input');input.type='file';input.accept='.mp4,.mov,.mkv,.avi,.webm';root.append(input);
    const cancel=document.createElement('button');cancel.textContent='取消转换';cancel.onclick=()=>{this.cancel();status.textContent='已取消，保留原视频资源';};root.append(cancel);
    const clear=document.createElement('button');clear.textContent='清除视频';clear.onclick=()=>{this.cancel();this.setValue('');this.sourceBlock_?.setWarningText(null);preview.removeAttribute('src');this.releasePreview();status.textContent=this.getText();};root.append(clear);
    let selected:File|undefined;
    const convert=async()=>{
      if(!selected) {status.textContent='尺寸改变后请重新选择原视频进行转换';return;}
      this.cancel();const generation=this.generation;
      const converter=new CycoreVideoConverter();this.converter=converter;
      (window.cycoreVideoConversions ||= new Set()).add(this);
      this.releasePreview();this.previewUrl=URL.createObjectURL(selected);preview.src=this.previewUrl;
      const [width,height]=select.value.split('×').map(Number);
      try {
        const value=await converter.convert(selected,width,height,message=>{if(generation===this.generation)status.textContent=message;});
        if(generation!==this.generation || !this.sourceBlock_)return;
        this.setValue(JSON.stringify(value));this.sourceBlock_.setWarningText(null);status.textContent=this.getText();
      }catch(e){if(generation===this.generation){status.textContent=e instanceof Error?e.message:String(e);this.sourceBlock_?.setWarningText(status.textContent);}}
      finally{if(generation===this.generation){window.cycoreVideoConversions?.delete(this);this.converter=undefined;}}
    };
    input.onchange=()=>{selected=input.files?.[0];void convert();};select.onchange=()=>void convert();
    // A saved resource can preview its first JPEG even after the original file is gone.
    try {const v=JSON.parse(this.getValue());const b=Uint8Array.from(atob(v.base64),(c:string)=>c.charCodeAt(0));const d=new DataView(b.buffer);this.releasePreview();this.previewUrl=URL.createObjectURL(new Blob([b.slice(d.getUint32(32,true),d.getUint32(32,true)+d.getUint32(36,true))],{type:'image/jpeg'}));preview.poster=this.previewUrl;}catch{}
    Blockly.DropDownDiv.getContentDiv().append(root);
    Blockly.DropDownDiv.showPositionedByField(this,()=>{this.cancel();preview.pause();preview.removeAttribute('src');this.releasePreview();});
  }
}
Blockly.fieldRegistry.register('field_cycore_video',FieldCycoreVideo);
