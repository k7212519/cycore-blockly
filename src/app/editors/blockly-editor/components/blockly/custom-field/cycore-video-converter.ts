import { FFmpeg } from '@ffmpeg/ffmpeg';

export const MAX_VIDEO_SOURCE = 5 * 1024 * 1024;
const MAX_RESOURCE = 7 * 1024 * 1024; // Conservative upper bound; final firmware capacity is checked by builder.
export interface CycoreVideoValue {
  version: 1; fileName: string; sourceSize: number; width: number; height: number;
  frames: number; durationMs: number; hasAudio: boolean; base64: string; crc32: number;
}
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let j=0;j<8;j++) crc=(crc>>>1)^((crc&1)?0xedb88320:0); }
  return (crc ^ 0xffffffff) >>> 0;
}
export function packVideo(jpeg: Uint8Array, pcm: Uint8Array, width: number, height: number): Uint8Array {
  const frames: [number,number][] = [];
  let start = 0;
  for(let i=0;i<jpeg.length-1;i++) if(jpeg[i]===255 && jpeg[i+1]===217) {
    if(jpeg[start]!==255 || jpeg[start+1]!==216) throw new Error('转换后的 JPEG 帧无效');
    frames.push([start,i+2-start]); start=i+2; i++;
  }
  if(!frames.length || start!==jpeg.length) throw new Error('视频没有完整画面');
  if(pcm.length && pcm.length!==frames.length*3200) throw new Error('音频长度与画面不一致');
  const audioOffset=32+frames.length*8+jpeg.length;
  if(audioOffset+pcm.length>MAX_RESOURCE) throw new Error('转换后资源过大，请缩短视频；不会自动裁短');
  const out=new Uint8Array(audioOffset+pcm.length), view=new DataView(out.buffer);
  out.set([67,71,86,49]);
  [width,height,frames.length,frames.length*100,audioOffset,pcm.length/2,16000].forEach((v,i)=>view.setUint32(4+i*4,v,true));
  frames.forEach(([off,len],i)=>{view.setUint32(32+i*8,32+frames.length*8+off,true);view.setUint32(36+i*8,len,true);});
  out.set(jpeg,32+frames.length*8);out.set(pcm,audioOffset);return out;
}
function base64(bytes: Uint8Array): string {
  let s='';for(let i=0;i<bytes.length;i+=32768)s+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(s);
}
class VideoEncodingError extends Error {}

export class CycoreVideoConverter {
  private ffmpeg = new FFmpeg();
  private cancelled = false;
  cancel(): void { this.cancelled = true; this.ffmpeg.terminate(); }
  // FFmpeg's own timeout cannot interrupt a stuck WASM encoder loop.
  private async bounded<T>(task: Promise<T>, ms: number, stage: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([task, new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(stage + '超时，已停止转换，请重新选择视频或缩短视频后重试'));
          this.ffmpeg.terminate();
        }, ms);
      })]);
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }
  async convert(file: File, width: number, height: number, progress: (message: string)=>void): Promise<CycoreVideoValue> {
    if (this.cancelled) throw new Error('转换已取消');
    try {
      return await this.attempt(file, width, height, progress, 'optimal');
    } catch (error) {
      if (this.cancelled || !(error instanceof VideoEncodingError)) throw error;
      progress('优化模式未能完成，正在自动切换兼容模式重新转换…');
      if (this.cancelled) throw new Error('转换已取消');
      // A stuck WASM worker cannot be reused. Start once with a clean worker/filesystem.
      this.ffmpeg = new FFmpeg();
      return await this.attempt(file, width, height, progress, 'default');
    }
  }
  private async attempt(file: File, width: number, height: number, progress: (message: string)=>void,
      huffman: 'optimal' | 'default'): Promise<CycoreVideoValue> {
    if(!file.size || file.size>MAX_VIDEO_SOURCE) throw new Error('单个原视频必须大于 0 且不超过 5 MiB');
    if(!/\.(mp4|mov|mkv|avi|webm)$/i.test(file.name)) throw new Error('请选择 MP4、MOV、MKV、AVI 或 WebM');
    if(![[240,240],[240,320],[320,240]].some(s=>s[0]===width&&s[1]===height)) throw new Error('无效的视频尺寸');
    const f=this.ffmpeg;
    let log='';
    f.on('log',({message})=>{log=(log+'\n'+message).slice(-6000);});
    const mode = huffman === 'optimal' ? '优化模式' : '兼容模式';
    let stage = `正在转换画面（${mode}）`;
    let lastAdvance = performance.now(), lastTime = -1;
    f.on('progress',({progress:p,time})=>{
      if (Number.isFinite(time) && time > lastTime) { lastTime = time; lastAdvance = performance.now(); }
      progress(`${stage} ${Math.round(Math.max(0,Math.min(1,p))*100)}%`);
    });
    try {
      progress(`正在加载视频转换组件（${mode}）…`);
      const asset=(path:string)=>new URL('assets/ffmpeg/'+path,document.baseURI).href;
      await this.bounded(f.load({coreURL:asset('core/ffmpeg-core.js'),wasmURL:asset('core/ffmpeg-core.wasm'),classWorkerURL:asset('worker/worker.js')}),60000,'加载视频转换组件');
      await f.writeFile('input',new Uint8Array(await file.arrayBuffer()));
      // core 0.12.10 ffprobe can return -1 after a successful probe. Validate its JSON output instead.
      progress('正在读取视频信息…');
      await this.bounded(f.ffprobe(['-v','error','-show_error','-show_streams','-show_format','-of','json','-o','info.json','input'],30000),35000,'读取视频信息');
      const info=JSON.parse(new TextDecoder().decode(await f.readFile('info.json') as Uint8Array));
      if(info.error || !Array.isArray(info.streams)) throw new Error('无法解析视频');
      const video=info.streams?.find((s:any)=>s.codec_type==='video' && !s.disposition?.attached_pic);
      const audios=info.streams?.filter((s:any)=>s.codec_type==='audio')||[];
      const audio=audios.find((s:any)=>s.disposition?.default)||audios[0];
      if(!video) throw new Error('文件没有视频轨道');
      const start=Number(video.start_time ?? info.format?.start_time ?? 0);
      if(!Number.isFinite(start)) throw new Error('无效的视频起始时间');
      const duration=Number(video.duration ?? info.format?.duration);
      if(!Number.isFinite(duration) || duration<=0) throw new Error('无法确定视频时长');
      if(audio && duration*32000>MAX_RESOURCE) throw new Error('视频声音已超过固件容量，请缩短视频');
      progress(`正在转换画面（${mode}）…`);
      // -fs bounds memory; reaching the bound is rejected, never delivered as a truncated clip.
      let stallTimer: ReturnType<typeof setInterval> | undefined;
      lastAdvance = performance.now(); lastTime = -1;
      try {
        const stalled = new Promise<never>((_, reject) => {
          stallTimer = setInterval(() => {
            if (performance.now() - lastAdvance >= 15000) {
              reject(new VideoEncodingError('画面转换连续 15 秒没有进展'));
              f.terminate();
            }
          }, 1000);
        });
        const encoding = this.bounded(f.exec(['-v','error','-i','input','-map',`0:${video.index}`,'-an','-vf',
          `setpts=PTS-STARTPTS,fps=10,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1`,
          '-c:v','mjpeg','-huffman',huffman,'-q:v','6','-pix_fmt','yuvj420p','-fs',String(MAX_RESOURCE),'-f','mjpeg','frames.mjpg'],120000),125000,'转换画面');
        const rc = await Promise.race([encoding, stalled]);
        if(rc!==0) throw new VideoEncodingError('视频解码失败或转换超时');
      } catch(error) {
        if (this.cancelled) throw new Error('转换已取消');
        throw new VideoEncodingError(error instanceof Error ? error.message : String(error));
      } finally { if (stallTimer !== undefined) clearInterval(stallTimer); }
      const jpeg=await f.readFile('frames.mjpg') as Uint8Array;
      if(jpeg.length>=MAX_RESOURCE) throw new Error('转换后画面过大，请缩短视频');
      const silent=packVideo(jpeg,new Uint8Array(),width,height);
      const frames=new DataView(silent.buffer).getUint32(12,true);
      let pcm=new Uint8Array();
      if(audio) {
        if(jpeg.length+frames*3200+32+frames*8>MAX_RESOURCE) throw new Error('转换后音画资源过大，请缩短视频');
        stage = '正在转换声音';
        progress('正在转换声音并同步时间…');
        // Preserve timestamps relative to the first video frame, including leading silence.
        const result=await this.bounded(f.exec(['-v','error','-copyts','-i','input','-map',`0:${audio.index}`,'-vn','-af',
          `asetpts=PTS-(${start})/TB,aresample=16000:async=1:first_pts=0,apad,atrim=end_sample=${frames*1600}`,
          '-ac','1','-ar','16000','-c:a','pcm_s16le','-f','s16le','audio.pcm'],120000),125000,'转换声音');
        if(result!==0) throw new Error('音轨解码失败或转换超时');
        pcm=new Uint8Array(await f.readFile('audio.pcm') as Uint8Array);
      }
      const bytes=packVideo(jpeg,pcm,width,height);
      return {version:1,fileName:file.name,sourceSize:file.size,width,height,frames,durationMs:frames*100,hasAudio:!!audio,base64:base64(bytes),crc32:crc32(bytes)};
    } catch(e) {
      if (e instanceof VideoEncodingError) throw e;
      const message=e instanceof Error?e.message:String(e);
      throw new Error(message+(log.includes('Decoder')||log.includes('decoder')?'；当前组件不支持该视频或音轨编码':''));
    } finally { f.terminate(); }
  }
}
