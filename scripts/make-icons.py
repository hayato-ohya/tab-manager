"""Generate the extension icons from the Tab Session Manager floppy shape
(Sienori, MPL-2.0), recolored: teal -> white, white -> transparent.

Writes icons/icon{16,32,48,128}.png (white on transparent), icons/icon.svg and
icons/logo.svg (the same mark on a slate background, used for favicons and the
options page logo). No external dependencies: even-odd scanline fill with 4x4
supersampling.
"""
import os
import re
import struct
import sys
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ICONS = os.path.join(HERE, '..', 'icons')
SS = 4
VIEW = 64.0
PATH = ('M 0 0 L 0 64 L 64 64 L 64 15 L 64 12 L 52 0 L 0 0 z '
        'M 8 8 L 16 8 L 16 24 L 48 24 L 48 8 L 49 8 L 56 15 L 56 56 L 8 56 L 8 8 z '
        'M 36 8 L 38 8 L 40 8 L 42 8 L 42 20 L 40 20 L 38 20 L 36 20 L 36 8 z')


def png(width, height, pixels):
    raw = b''.join(b'\x00' + bytes(row) for row in pixels)

    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)

    return (b'\x89PNG\r\n\x1a\n'
            + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))


def parse_path(d):
    polys, cur, cmd = [], [], None
    tokens = re.findall(r'[MLz]|-?\d+(?:\.\d+)?', d)
    i = 0
    while i < len(tokens):
        tok = tokens[i]
        if tok in 'MLz':
            cmd = tok
            i += 1
            if cmd == 'z' and cur:
                polys.append(cur)
                cur = []
            continue
        x, y = float(tok), float(tokens[i + 1])
        i += 2
        if cmd == 'M' and cur:
            polys.append(cur)
            cur = []
        cur.append((x, y))
    if cur:
        polys.append(cur)
    return polys


POLYS = parse_path(PATH)


def inside(x, y):
    hit = False
    for poly in POLYS:
        n = len(poly)
        for j in range(n):
            x1, y1 = poly[j]
            x2, y2 = poly[(j + 1) % n]
            if (y1 > y) != (y2 > y) and x1 + (y - y1) * (x2 - x1) / (y2 - y1) > x:
                hit = not hit
    return hit


def render(size):
    scale = VIEW / size
    rows = []
    for py in range(size):
        row = []
        for px in range(size):
            cover = 0
            for sy in range(SS):
                for sx in range(SS):
                    if inside((px + (sx + 0.5) / SS) * scale, (py + (sy + 0.5) / SS) * scale):
                        cover += 1
            row += [255, 255, 255, round(255 * cover / (SS * SS))]
        rows.append(row)
    return png(size, size, rows)


ICON_SVG = f'''<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <!-- Based on the Tab Session Manager icon by Sienori (MPL-2.0), recolored: teal -> white, white -> transparent. -->
  <path fill="#ffffff" d="{PATH}"/>
</svg>
'''

LOGO_SVG = f'''<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <!-- The toolbar mark on a slate background (favicon / options page logo). -->
  <rect width="64" height="64" rx="10" fill="#37474f"/>
  <g transform="translate(10 10) scale(0.6875)">
    <path fill="#ffffff" d="{PATH}"/>
  </g>
</svg>
'''


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else ICONS
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, 'icon.svg'), 'w', encoding='utf-8') as f:
        f.write(ICON_SVG)
    with open(os.path.join(out, 'logo.svg'), 'w', encoding='utf-8') as f:
        f.write(LOGO_SVG)
    for size in (16, 32, 48, 128):
        with open(os.path.join(out, f'icon{size}.png'), 'wb') as f:
            f.write(render(size))
    print('icons written')


if __name__ == '__main__':
    main()
