"""Real Chromium/WASM conversion + Blockly round-trip regression.
Requires npm ci, ffmpeg, Python playwright and installed Chromium or Google Chrome.
Run: python3 scripts/test-cycore-video.py
"""
import functools
import http.server
import json
import base64
import struct
import subprocess
import tempfile
import threading
import argparse
import shutil
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
FIELD=ROOT/'src/app/editors/blockly-editor/components/blockly/custom-field'

def run(args):
    subprocess.run([str(a) for a in args],check=True,capture_output=True)

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--video',type=Path,help='Optional local regression video; kept outside the repository')
    parser.add_argument('--expect-fallback',action='store_true',help='Require compatibility retry for the optional regression video')
    args=parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='cycore-video-test-') as tmp:
        web=Path(tmp)
        for name,src in [('core','core'),('worker','ffmpeg')]:
            target=web/'assets/ffmpeg'/name
            target.parent.mkdir(parents=True,exist_ok=True)
            target.symlink_to(ROOT/f'node_modules/@ffmpeg/{src}/dist/esm',target_is_directory=True)
        run([ROOT/'node_modules/.bin/esbuild',FIELD/'cycore-video-converter.ts','--bundle','--format=esm',f'--outfile={web}/converter.js'])
        base=['ffmpeg','-v','error','-y','-f','lavfi','-i','testsrc2=size=160x120:rate=10','-f','lavfi','-i','sine=frequency=440:sample_rate=16000','-t','1']
        for name,vc,ac,extra in [('test.mp4','libx264','aac',[]),('h264.mov','libx264','aac',[]),('hevc.mkv','libx265','aac',['-x265-params','log-level=error']),('mpeg4.avi','mpeg4','libmp3lame',[]),('vp8.webm','libvpx','libopus',[]),('vp9.webm','libvpx-vp9','libopus',[])]:
            run(base+['-c:v',vc,'-c:a',ac]+extra+[web/name])
        run(['ffmpeg','-v','error','-y','-i',web/'test.mp4','-an','-c:v','copy',web/'silent.mp4'])
        run(['ffmpeg','-v','error','-y','-display_rotation:v:0','90','-i',web/'test.mp4','-c','copy',web/'rotated.mp4'])
        run(['ffmpeg','-v','error','-y','-f','lavfi','-i','testsrc2=size=160x120:rate=10','-itsoffset','0.4','-f','lavfi','-i','sine=frequency=440:sample_rate=16000','-t','1','-c:v','libx264','-c:a','aac',web/'delayed.mp4'])
        if args.video: shutil.copyfile(args.video,web/'regression.mp4')
        (web/'bad.mp4').write_bytes(b'invalid video')
        source=(web/'test.mp4').read_bytes()
        (web/'exact.mp4').write_bytes(source+b'\0'*(5*1024*1024-len(source)))
        (web/'index.html').write_text('''<!doctype html><script type="module">
import {CycoreVideoConverter} from './converter.js';
window.convert=async name=>{window.messages=[];const blob=await(await fetch(name)).blob();window.activeConverter=new CycoreVideoConverter();return window.activeConverter.convert(new File([blob],name),240,240,m=>window.messages.push(m));};
window.oversize=()=>new CycoreVideoConverter().convert(new File([new Uint8Array(5242881)],'large.mp4'),240,240,()=>{});
</script>''')
        (web/'entry.ts').write_text(f'''import * as Blockly from {json.dumps(str(ROOT/'node_modules/blockly/index.js'))};
import {json.dumps(str(FIELD/'field-cycore-video'))};
Blockly.defineBlocksWithJsonArray([{{type:'video_test',message0:'视频 %1',args0:[{{type:'field_cycore_video',name:'VIDEO'}}],colour:'#009688'}}]);
const workspace=Blockly.inject(document.getElementById('workspace')!,{{toolbox:{{kind:'flyoutToolbox',contents:[]}}}});
const block=workspace.newBlock('video_test');block.initSvg();block.render();Object.assign(window,{{Blockly,workspace,block}});''')
        run([ROOT/'node_modules/.bin/esbuild',web/'entry.ts','--bundle','--format=esm',f'--outfile={web}/field.js'])
        (web/'field.html').write_text('<!doctype html><div id="workspace" style="width:900px;height:650px"></div><script type="module" src="field.js"></script>')
        class Handler(http.server.SimpleHTTPRequestHandler):
            def log_message(self,*args):pass
        server=http.server.ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(web)))
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        try:
            with sync_playwright() as p:
                chrome=Path('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
                browser=p.chromium.launch(headless=True,**({'executable_path':str(chrome)} if chrome.exists() else {}))
                page=browser.new_page();url=f'http://127.0.0.1:{server.server_port}'
                page.goto(url);page.wait_for_load_state('networkidle')
                original=None
                for name in ['test.mp4','h264.mov','hevc.mkv','mpeg4.avi','vp8.webm','vp9.webm','silent.mp4','rotated.mp4','delayed.mp4','exact.mp4']:
                    r=page.evaluate('name=>window.convert(name)',name)
                    assert 10<=r['frames']<=12 and r['hasAudio']==(name!='silent.mp4'),name
                    if name=='test.mp4':original=r['base64']
                    if name=='rotated.mp4':assert r['base64']!=original,'rotation ignored'
                    if name=='delayed.mp4':
                        data=base64.b64decode(r['base64']);off=struct.unpack_from('<I',data,20)[0]
                        pcm=struct.unpack('<'+str((len(data)-off)//2)+'h',data[off:])
                        assert max(map(abs,pcm[:4000]))<10 and max(map(abs,pcm[9000:]))>100,'audio offset lost'
                    print('PASS',name,flush=True)
                if args.video:
                    r=page.evaluate('()=>window.convert("regression.mp4")')
                    assert r['frames']>0 and r['durationMs']>0
                    if args.expect_fallback: assert page.evaluate('messages.some(m=>m.includes("自动切换"))')
                    if args.expect_fallback:
                        page.evaluate('()=>{window.pending=window.convert("regression.mp4").then(()=>"completed",()=>"cancelled");}')
                        page.wait_for_function('messages.some(m=>m.includes("1%"))',timeout=15000)
                        page.evaluate('activeConverter.cancel()')
                        assert page.evaluate('window.pending')=='cancelled'
                        assert not page.evaluate('messages.some(m=>m.includes("自动切换"))')
                    print('PASS local regression video:',r['frames'],'frames, audio:',r['hasAudio'],flush=True)
                for expr in ['window.convert("bad.mp4")','window.oversize()']:
                    result=page.evaluate(f'async()=>{{try{{await {expr};return false;}}catch{{return true;}}}}')
                    assert result,expr
                page.goto(url+'/field.html');page.wait_for_load_state('networkidle');page.evaluate('block.getField("VIDEO").showEditor_()')
                assert page.locator('input[type=file]').count()==1
                page.locator('input[type=file]').set_input_files(str(web/'test.mp4'))
                page.wait_for_function('block.getFieldValue("VIDEO").length>0 && !window.cycoreVideoConversions.size',timeout=120000)
                page.locator('select').select_option('320×240')
                page.wait_for_function('JSON.parse(block.getFieldValue("VIDEO")).width===320 && !window.cycoreVideoConversions.size',timeout=120000)
                page.evaluate('Blockly.DropDownDiv.hideWithoutAnimation();window.saved=Blockly.serialization.workspaces.save(workspace);Blockly.serialization.workspaces.load(saved,workspace);window.block=workspace.getAllBlocks()[0]')
                assert page.evaluate('JSON.parse(block.getFieldValue("VIDEO")).width')==320
                page.evaluate('block.getField("VIDEO").showEditor_()')
                page.locator('input[type=file]').set_input_files(str(web/'test.mp4'));page.get_by_role('button',name='取消转换').click()
                assert page.evaluate('window.cycoreVideoConversions.size')==0
                assert page.evaluate('JSON.parse(block.getFieldValue("VIDEO")).width')==320
                page.get_by_role('button',name='清除视频').click();assert page.evaluate('block.getFieldValue("VIDEO")')==''
                print('PASS field resize, save/reload, cancellation, clear, size and corruption checks',flush=True)
                browser.close()
        finally:server.shutdown();server.server_close()
if __name__=='__main__':main()
