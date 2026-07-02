#!/usr/bin/env python3
"""Compose a Chrome Web Store screenshot (1280x800, 24-bit PNG, no alpha).

Places a UI capture on the right of a branded canvas with headline + bullets
on the left. Store spec: 1280x800 or 640x400, JPEG/24-bit PNG without alpha.

  tools/store-screenshot.py <capture.png> <output.png> \
      --head1 "Timestamp every" --head2 "AI conversation." \
      --sub "One-line subtitle" --points "Point A" "Point B" ...

For wide captures (a full conversation window) use --wide: the capture fills
the width at the bottom and the headline sits above it.
"""
import argparse
from PIL import Image, ImageDraw, ImageFont, ImageFilter

W, H = 1280, 800
FONTS = '/usr/share/fonts/rsms-inter-fonts/'
TOP, BOTTOM = (17, 16, 51), (39, 36, 110)
ACCENT = (129, 140, 248)


def gradient():
    bg = Image.new('RGB', (W, H))
    px = bg.load()
    for y in range(H):
        t = y / H
        row = tuple(int(a + (b - a) * t) for a, b in zip(TOP, BOTTOM))
        for x in range(W):
            px[x, y] = row
    return bg


def rounded(shot, radius=14):
    mask = Image.new('L', shot.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, *shot.size), radius=radius, fill=255)
    return mask


def drop_shadow(bg, box, radius):
    shadow = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    x0, y0, x1, y1 = box
    ImageDraw.Draw(shadow).rounded_rectangle((x0 - 6, y0 + 10, x1 + 6, y1 + 22), radius=radius + 6, fill=(0, 0, 0, 130))
    return Image.alpha_composite(bg.convert('RGBA'), shadow.filter(ImageFilter.GaussianBlur(24))).convert('RGB')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('capture')
    ap.add_argument('output')
    ap.add_argument('--head1', required=True)
    ap.add_argument('--head2', default='')
    ap.add_argument('--sub', default='')
    ap.add_argument('--points', nargs='*', default=[])
    ap.add_argument('--wide', action='store_true')
    args = ap.parse_args()

    bg = gradient()
    shot = Image.open(args.capture).convert('RGB')
    d = ImageDraw.Draw(bg)
    f_head = ImageFont.truetype(FONTS + 'Inter-Bold.ttf', 54 if not args.wide else 46)
    f_sub = ImageFont.truetype(FONTS + 'Inter-Regular.ttf', 26)
    f_point = ImageFont.truetype(FONTS + 'Inter-Medium.ttf', 24)
    f_brand = ImageFont.truetype(FONTS + 'Inter-SemiBold.ttf', 30)
    logo = Image.open('icons/logo-128.png').convert('RGBA').resize((56, 56), Image.LANCZOS)

    if args.wide:
        # headline on top, capture across the bottom
        scale = min((W - 160) / shot.width, 520 / shot.height)
        shot = shot.resize((int(shot.width * scale), int(shot.height * scale)), Image.LANCZOS)
        sx, sy = (W - shot.width) // 2, H - shot.height + 40  # bottom edge bleeds off canvas
        bg.paste(logo, (110, 60), logo)
        d = ImageDraw.Draw(bg)
        d.text((182, 70), 'Sigill', font=f_brand, fill=(230, 233, 255))
        d.text((110, 140), args.head1, font=f_head, fill=(255, 255, 255))
        if args.head2:
            d.text((110 + d.textlength(args.head1 + ' ', font=f_head), 140), args.head2, font=f_head, fill=ACCENT)
        if args.sub:
            d.text((110, 210), args.sub, font=f_sub, fill=(199, 205, 245))
        bg = drop_shadow(bg, (sx, sy, sx + shot.width, sy + shot.height), 14)
        bg.paste(shot, (sx, sy), rounded(shot))
    else:
        target_h = 690
        scale = target_h / shot.height
        shot = shot.resize((int(shot.width * scale), target_h), Image.LANCZOS)
        sx, sy = W - shot.width - 120, (H - target_h) // 2
        bg = drop_shadow(bg, (sx, sy, sx + shot.width, sy + shot.height), 14)
        bg.paste(shot, (sx, sy), rounded(shot))
        d = ImageDraw.Draw(bg)
        LX = 110
        bg.paste(logo, (LX, 96), logo)
        d.text((LX + 72, 106), 'Sigill', font=f_brand, fill=(230, 233, 255))
        d.text((LX, 230), args.head1, font=f_head, fill=(255, 255, 255))
        if args.head2:
            d.text((LX, 296), args.head2, font=f_head, fill=ACCENT)
        if args.sub:
            for i, line in enumerate(args.sub.split('|')):
                d.text((LX, 400 + i * 36), line.strip(), font=f_sub, fill=(199, 205, 245))
        y = 530
        for p in args.points:
            d.ellipse((LX, y + 9, LX + 10, y + 19), fill=ACCENT)
            d.text((LX + 28, y), p, font=f_point, fill=(226, 230, 255))
            y += 46

    bg.save(args.output)
    print(f'saved {args.output} {bg.size} {bg.mode}')


if __name__ == '__main__':
    main()
