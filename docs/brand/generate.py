"""Draws Bivouac's logo files (docs/brand/README.md). Run: python3 docs/brand/generate.py
It writes every SVG next to this script; the PNG avatar is exported from
bivouac-avatar.svg at 512 x 512 (for example with a headless browser)."""
import math, os, sys
OUT=sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.abspath(__file__))
CANVAS='#d4501c'; SHADE='#a8400f'; GLOW='#f5bd4f'; NIGHT='#151c1a'; SNOW='#f5f2eb'; INK='#1a221f'
SW=2.5  # stroke width in wordmark units
def tent(fill3=True, ink=None):
    if ink:  # single ink, door cut out
        return f'<path fill="{ink}" fill-rule="evenodd" d="M32 8 58 54H6Z M32 27 41 54H23Z"/>'
    return (f'<path fill="{CANVAS}" d="M32 8V54H6Z"/>'
            f'<path fill="{SHADE}" d="M32 8 58 54H32Z"/>'
            f'<path fill="{GLOW}" d="M32 27 41 54H23Z"/>')
# wordmark: baseline 20, x-height top 10, ascender 3.5; r=5
def word():
    x=0; parts=[]; g=3.6
    def circ(cx): return f'M{cx+5} 15A5 5 0 1 1 {cx-5} 15A5 5 0 1 1 {cx+5} 15'
    # b
    parts.append(f'M{x} 3.5V20'); parts.append(circ(x+5)); x+=10+g
    # i
    parts.append(f'M{x} 10V20'); dot=(x,5.6); x+=g
    # v
    parts.append(f'M{x} 10 {x+4.6} 20 {x+9.2} 10'); x+=9.2+g
    # o
    parts.append(circ(x+5)); x+=10+g
    # u
    parts.append(f'M{x} 10V15A5 5 0 0 0 {x+10} 15V10M{x+10} 15V20'); x+=10+g
    # a
    parts.append(circ(x+5)); parts.append(f'M{x+10} 10V20'); x+=10+g
    # c
    a=math.radians(48); sx=x+5+5*math.cos(a); sy1=15-5*math.sin(a); sy2=15+5*math.sin(a)
    parts.append(f'M{sx:.2f} {sy1:.2f}A5 5 0 1 0 {sx:.2f} {sy2:.2f}'); x+=10
    return ' '.join(parts), dot, x
WD, DOT, WW = word()
def wordmark(ink, tx, ty, s):
    return (f'<g transform="translate({tx} {ty}) scale({s})"><path d="{WD}" fill="none" stroke="{ink}" stroke-width="{SW}" stroke-linecap="round" stroke-linejoin="round"/>'
            f'<circle cx="{DOT[0]}" cy="{DOT[1]}" r="{SW*0.62:.2f}" fill="{ink}"/></g>')
def svg(w,h,body,bg=None,title='Bivouac'):
    b=f'<rect width="{w}" height="{h}" fill="{bg}"/>' if bg else ''
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" role="img" aria-label="{title}">{b}{body}</svg>\n'
S=2.5; LW=round(80+WW*S+SW*S/2+4)
files={
 'bivouac-mark.svg': svg(64,64,tent()),
 'bivouac-mark-ink.svg': svg(64,64,tent(ink=INK)),
 'bivouac-mark-snow.svg': svg(64,64,tent(ink=SNOW)),
 'bivouac-logo.svg': svg(LW,64,tent()+wordmark(INK,80,4,S)),
 'bivouac-logo-night.svg': svg(LW,64,tent()+wordmark(SNOW,80,4,S)),
 'bivouac-logo-ink.svg': svg(LW,64,tent(ink=INK)+wordmark(INK,80,4,S)),
 'bivouac-avatar.svg': svg(512,512,f'<g transform="translate(96 100) scale(5)">{tent()}</g>',bg=NIGHT),
 'favicon.svg': svg(64,64,f'<rect width="64" height="64" rx="14" fill="{NIGHT}"/><g transform="translate(5 4) scale(0.84)">{tent()}</g>'),
}
for n,c in files.items(): open(os.path.join(OUT,n),'w').write(c)
print('wordmark width', WW, 'logo width', LW)
