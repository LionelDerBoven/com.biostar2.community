import sys, math
sys.path.insert(0,'.')
from genassets import *
from PIL import Image

OUT='assets'

# Palette taken from the BioStar 2 mark: warm orange into magenta/purple.
BG_STOPS   = [(0.0,(255,158,27)),(0.35,(244,86,66)),(0.68,(226,40,124)),(1.0,(142,45,226))]
TILE_STOPS = [(0.0,(247,120,42)),(0.5,(226,40,110)),(1.0,(150,40,190))]

def build_image(w,h):
    bg = gradient((w,h), BG_STOPS)
    # centred rounded tile
    side = int(min(w,h)*0.62)
    x0=(w-side)//2; y0=(h-side)//2
    tile = gradient((side,side), TILE_STOPS, diagonal=False)
    tmask = rounded_rect_mask((side,side),(0,0,side-1,side-1), side*0.24)
    bg.paste(tile,(x0,y0),tmask)
    # white hollow star, no offset shadow
    star = star_mask((w,h), w/2, h/2 + side*0.005, side*0.36)
    white = Image.new('RGB',(w,h),(255,255,255))
    bg.paste(white,(0,0),star)
    return bg

for name,(w,h) in {'small':(250,175),'large':(500,350),'xlarge':(1000,700)}.items():
    build_image(w,h).save(f'{OUT}/images/{name}.png')
    print('wrote',name,w,'x',h)

# icon.svg — white hollow star on transparent; Homey draws the brandColor circle
S=512; c=S/2; r=S*0.36
outer=star_points(c,c,r,r*R_INNER_RATIO)
ri=r*(1-WALL)
inner=star_points(c,c,ri,ri*R_INNER_RATIO)
svg=f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {S} {S}" width="100%" height="100%">
  <!-- Transparent background: Homey applies the brandColor circle automatically. -->
  <!-- Hollow rounded star, evenodd so the centre cuts out cleanly. -->
  <path fill="#FFFFFF" fill-rule="evenodd"
        d="{to_svg(outer, r*CORNER_RADIUS)} {to_svg(inner, ri*CORNER_RADIUS)}" />
</svg>
'''
open(f'{OUT}/icon.svg','w').write(svg)
print('wrote icon.svg', len(svg),'bytes')
