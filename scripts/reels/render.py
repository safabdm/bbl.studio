"""Original deterministic 9:16 motion design, rendered offline. Never publishes.
Run: python -m pip install -r scripts/reels/requirements.txt
     python scripts/reels/render.py [--font /path/to/bold.ttf]
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess

from PIL import Image, ImageDraw, ImageFont, ImageChops
import imageio_ffmpeg

ROOT = Path(__file__).resolve().parents[2]
SPEC = json.loads((Path(__file__).with_name('booking-friction.json')).read_text())
W, H, FPS = SPEC['width'], SPEC['height'], SPEC['fps']
OUT = ROOT / 'outputs/reels'
BG, FG, ACCENT = '#0a0a0a', '#e6e1d7', '#ff5a36'

def clamp(x): return max(0, min(1, x))
def ease(x): return 1 - (1 - clamp(x)) ** 3

def font_path(requested):
    candidates = [requested, os.environ.get('BBL_REEL_FONT'), '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', '/System/Library/Fonts/Supplemental/Arial Bold.ttf']
    for candidate in candidates:
        if candidate and Path(candidate).is_file(): return candidate
    raise RuntimeError('Set BBL_REEL_FONT or --font to a licensed bold TTF font.')

def render(t, path):
    im = Image.new('RGB', (W, H), BG)
    d = ImageDraw.Draw(im)
    small, caption = ImageFont.truetype(path, 27), ImageFont.truetype(path, 34)
    d.text((86, 128), 'BBL STUDIO', font=small, fill=FG)
    d.text((810, 128), 'DESIGN / 01', font=ImageFont.truetype(path, 22), fill=ACCENT)
    d.line((86, 192, 994, 192), fill='#444444', width=2)
    index = next((i for i, s in enumerate(SPEC['scenes']) if s['start'] <= t < s['end']), 3)
    scene = SPEC['scenes'][index]
    local = t - scene['start']
    # Premium editorial type: fitted to a fixed 908 px safe area.
    size = 139 if index != 2 else 119
    while True:
        title = ImageFont.truetype(path, size)
        if max(d.textlength(line, font=title) for line in scene['lines']) <= 908: break
        size -= 1
    for i, line in enumerate(scene['lines']):
        y = 335 + i * (size + 10) + int(90 * (1 - ease((local - i * .09) / .75)))
        shade = ACCENT if i == len(scene['lines']) - 1 else FG
        d.text((86, y), line, font=title, fill=shade)
    if index in (0, 3):
        pivot = (540, 810 if index == 0 else 850)
        angle = .85 * math.cos(local * 2.8) * math.exp(-local * (.18 if index == 0 else .8))
        length = 365
        x, y = pivot[0] + math.sin(angle) * length, pivot[1] + math.cos(angle) * length
        d.ellipse((360, 1000, 720, 1360), outline='#3d3d3d', width=2)
        d.line((*pivot, x, y), fill=FG, width=5)
        d.ellipse((pivot[0]-9, pivot[1]-9, pivot[0]+9, pivot[1]+9), fill=FG)
        d.ellipse((x-78, y-78, x+78, y+78), fill=ACCENT)
        if index == 3:
            d.text((86, 1430), 'bbl.studio', font=ImageFont.truetype(path, 68), fill=FG)
    else:
        align = ease((local - .15) / 1.2) if index == 2 else 0
        for i in range(3):
            x = int(130 + (i * 70 + math.sin(local * 1.6 + i) * 26) * (1-align))
            y = int(920 + i * 130)
            fill = ACCENT if index == 2 and i == 2 else '#232323'
            d.rounded_rectangle((x,y,x+720,y+105), radius=26, fill=fill, outline='#565656', width=2)
            label = (['SERVICE', 'DETAILS', 'BOOK A CONSULTATION'] if index == 2 else ['FIND THE SERVICE', 'WHERE DO I BOOK?', 'START AGAIN'])[i]
            d.text((x+35,y+34),label,font=small,fill=BG if fill==ACCENT else FG)
            d.text((x+655,y+33),'→',font=small,fill=BG if fill==ACCENT else ACCENT)
        cx = int(855 - 95 * ease(local / 2))
        cy = int(1290 + 18 * math.sin(local*3)*math.exp(-local))
        d.polygon([(cx,cy),(cx,cy+62),(cx+17,cy+45),(cx+32,cy+72),(cx+47,cy+64),(cx+31,cy+36),(cx+56,cy+32)],fill=FG,outline=BG,width=3)
    # Readable burned-in captions, wrapped inside platform-safe margins.
    words, lines, current = scene['subtitle'].split(), [], ''
    for word in words:
        trial = (current + ' ' + word).strip()
        if d.textlength(trial,font=caption)>908: lines.append(current);current=word
        else: current=trial
    lines.append(current)
    for i,line in enumerate(lines): d.text((86,1550+i*52),line,font=caption,fill=FG)
    d.line((86, 1748, 994, 1748),fill='#444444',width=3)
    d.line((86,1748,86+908*clamp(t/SPEC['duration']),1748),fill=ACCENT,width=4)
    d.text((86,1785),'WEB / UX / BRAND',font=small,fill='#a6a6a6')
    d.text((920,1785),f'{index+1:02}',font=small,fill=FG)
    # Short filmic dip at cuts; no flashing or strobing.
    fade = min(ease(local/.25),ease((scene['end']-t)/.25))
    if fade<1: im=Image.blend(Image.new('RGB',(W,H),BG),im,fade)
    return im

def main():
    global SPEC, W, H, FPS
    parser=argparse.ArgumentParser();parser.add_argument('--font');parser.add_argument('--spec',type=Path,default=Path(__file__).with_name('booking-friction.json'));args=parser.parse_args()
    SPEC=json.loads(args.spec.read_text())
    if SPEC['width']!=1080 or SPEC['height']!=1920 or SPEC['fps']!=30 or not 5<=SPEC['duration']<=60 or len(SPEC['scenes'])!=4:
        raise ValueError('This editorial template requires four scenes, 1080x1920, 30fps, 5–60 seconds.')
    previous=0
    for scene in SPEC['scenes']:
        if scene['start']!=previous or scene['end']<=scene['start'] or not 1<=len(scene['lines'])<=3 or any(not line.strip() or len(line)>40 for line in scene['lines']): raise ValueError('Use contiguous scenes with 1–3 short readable title lines.')
        previous=scene['end']
    if previous!=SPEC['duration']: raise ValueError('Storyboard duration must match video duration.')
    W,H,FPS=SPEC['width'],SPEC['height'],SPEC['fps']
    path=font_path(args.font);OUT.mkdir(parents=True,exist_ok=True)
    ffmpeg=imageio_ffmpeg.get_ffmpeg_exe();video=OUT/'bbl-booking-friction.mp4'
    frames=int(FPS*SPEC['duration'])
    process=subprocess.Popen([ffmpeg,'-y','-loglevel','error','-f','rawvideo','-vcodec','rawvideo','-pix_fmt','rgb24','-s',f'{W}x{H}','-r',str(FPS),'-i','-','-an','-c:v','libx264','-preset','fast','-crf','20','-pix_fmt','yuv420p','-movflags','+faststart',str(video)],stdin=subprocess.PIPE)
    for f in range(frames): process.stdin.write(render(f/FPS,path).tobytes())
    process.stdin.close()
    if process.wait()!=0: raise RuntimeError('FFmpeg render failed')
    # Decode the actual encoded artifact to verify dimensions, frame count and motion.
    reader=imageio_ffmpeg.read_frames(str(video),pix_fmt='rgb24');metadata=next(reader)
    decoded=0;hashes=set()
    for frame in reader:
        if decoded%30==15: hashes.add(hashlib.sha256(frame).hexdigest())
        decoded+=1
    assert metadata['size']==(W,H) and decoded==frames and len(hashes)>=12, 'Motion/video QA failed'
    contact=Image.new('RGB',(1080,960),BG)
    for i,t in enumerate([1.8,6,11,16]): contact.paste(render(t,path).resize((270,480)),(i*270,0))
    d=ImageDraw.Draw(contact);d.text((40,560),'BBL STUDIO — ORIGINAL MOTION PROOF',font=ImageFont.truetype(path,32),fill=FG)
    d.text((40,630),'18 seconds / 1080 × 1920 / 30 fps / H.264',font=ImageFont.truetype(path,28),fill=ACCENT)
    d.text((40,700),'Pendulum / kinetic type / interface transitions',font=ImageFont.truetype(path,26),fill=FG)
    d.text((40,770),'Draft only. Publication requires owner approval.',font=ImageFont.truetype(path,26),fill=FG)
    contact.save(OUT/'storyboard.jpg')
    (OUT/'content.json').write_text(json.dumps(SPEC,indent=2))
    def stamp(seconds):
        milliseconds=round(seconds*1000);return f'{milliseconds//3600000:02}:{milliseconds//60000%60:02}:{milliseconds//1000%60:02},{milliseconds%1000:03}'
    (OUT/'captions.srt').write_text('\n\n'.join(f"{i+1}\n{stamp(s['start'])} --> {stamp(s['end'])}\n{' '.join(s['lines'])}\n{s['subtitle']}" for i,s in enumerate(SPEC['scenes'])))
    report={'video':video.name,'sha256':hashlib.sha256(video.read_bytes()).hexdigest(),'width':W,'height':H,'fps':FPS,'frames':decoded,'unique_sampled_frames':len(hashes),'duration_seconds':SPEC['duration'],'audio':'intentional silent motion with burned-in captions','status':'draft','published':False,'font':Path(path).name,'checks':['decoded H.264 video','9:16','540 frames','motion varies over time','caption safe margins'],'claims':SPEC['claims']}
    (OUT/'quality-report.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))

if __name__=='__main__': main()
