"""Draws the iPhone app icon and launch screen in the app's Memphis style (src/memphis.css).

Run from the repo root: python3 scripts/make-ios-art.py
"""
import math
from pathlib import Path
from PIL import Image, ImageDraw

ASSETS = Path('ios/App/App/Assets.xcassets')
YELLOW, PINK, TEAL, VIOLET, ORANGE, BLUE = '#ffd23f', '#ff6fae', '#2ed3c0', '#a78bfa', '#ff8c42', '#5b8cff'
INK, PAPER, NIGHT = '#111111', '#fffdf5', '#1d1d1f'


def poly(d, pts, fill, edge, drop):
    """A Memphis shape: hard offset shadow, then the fill with a thick ink edge."""
    d.polygon([(x + drop, y + drop) for x, y in pts], fill=INK)
    d.polygon(pts, fill=fill, outline=INK, width=edge)


def plane(cx, cy, scale):
    """A paper plane pointing up and to the right: the top wing and the folded underside."""
    def at(x, y):
        a = math.radians(-28)
        x, y = x * scale, y * scale
        return (cx + x * math.cos(a) - y * math.sin(a), cy + x * math.sin(a) + y * math.cos(a))
    nose, top, crease, bottom = at(330, 0), at(-290, -190), at(-110, 40), at(-210, 190)
    return [nose, top, crease], [nose, crease, bottom]


def draw_icon(n=1024):
    img = Image.new('RGB', (n, n), YELLOW)
    d = ImageDraw.Draw(img)
    e, s = n // 64, n // 40  # edge width, shadow offset
    # confetti
    d.pieslice([n * .62, -n * .12, n * 1.1, n * .36], 0, 180, fill=BLUE, outline=INK, width=e)
    poly(d, [(n * .07, n * .84), (n * .21, n * .76), (n * .19, n * .94)], TEAL, e, s)
    for i in range(4):
        for j in range(3):
            r = n * .014
            x, y = n * (.74 + i * .055), n * (.78 + j * .055)
            d.ellipse([x - r, y - r, x + r, y + r], fill=VIOLET)
    pts = [(n * (.06 + k * .045), n * (.20 + (.035 if k % 2 else -.035))) for k in range(6)]
    d.line(pts, fill=PINK, width=e * 2, joint='curve')
    # the plane
    wing, fold = plane(n * .50, n * .52, n / 1024)
    for part in (wing, fold):  # one shadow for the whole plane, under both halves
        d.polygon([(x + s, y + s) for x, y in part], fill=INK)
    d.polygon(fold, fill=ORANGE, outline=INK, width=e)
    d.polygon(wing, fill=PAPER, outline=INK, width=e)
    return img


def draw_splash(n=2732):
    # dark like the app's first paint, with the icon in the middle (scaleAspectFill keeps the centre)
    img = Image.new('RGB', (n, n), NIGHT)
    icon = draw_icon(1024).resize((360, 360), Image.LANCZOS)
    mask = Image.new('L', icon.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, 359, 359], radius=80, fill=255)
    img.paste(icon, ((n - 360) // 2, (n - 360) // 2), mask)
    return img


if __name__ == '__main__':
    draw_icon().save(ASSETS / 'AppIcon.appiconset/AppIcon-512@2x.png')
    splash = draw_splash()
    for name in ('splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png'):
        splash.save(ASSETS / 'Splash.imageset' / name)
    print('icon and splash written')
