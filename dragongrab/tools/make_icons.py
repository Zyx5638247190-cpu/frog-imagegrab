# -*- coding: utf-8 -*-
"""
奶龙取图 / DragonGrab —— 图标生成脚本（不依赖任何第三方库）

用法:  python tools/make_icons.py
输出:  icons/icon16.png  icons/icon48.png  icons/icon128.png

绘制内容：黄色 Q 版小奶龙（圆滚滚的头 + 两只小角 + 大眼睛 + 微笑），
使用 4 倍超采样做抗锯齿，纯 zlib 手写 PNG，无需 Pillow。
"""
import math
import os
import struct
import zlib

SS = 4  # 超采样倍数，越大边缘越平滑

YELLOW_TOP = (0xFF, 0xE0, 0x82)
YELLOW_BOTTOM = (0xFF, 0xB3, 0x00)
HORN = (0xFF, 0x8F, 0x00)
BELLY = (0xFF, 0xF8, 0xE1)
WHITE = (0xFF, 0xFF, 0xFF)
PUPIL = (0x4E, 0x34, 0x2E)
MOUTH = (0x6D, 0x4C, 0x41)
CHEEK = (0xFF, 0xAB, 0x91)


def blend(base, top, alpha):
    """把 top 以 alpha(0~1) 覆盖到 base 上；base/top 的 alpha 分量也用 0~1 表示"""
    if alpha <= 0:
        return base
    a = alpha + base[3] * (1 - alpha)
    if a <= 0:
        return (0.0, 0.0, 0.0, 0.0)
    out = []
    for i in range(3):
        out.append((top[i] * alpha + base[i] * base[3] * (1 - alpha)) / a)
    out.append(a)
    return tuple(out)


def in_ellipse(u, v, cx, cy, rx, ry):
    return ((u - cx) / rx) ** 2 + ((v - cy) / ry) ** 2 <= 1.0


def in_triangle(px, py, a, b, c):
    def sign(p1, p2, p3):
        return (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1])
    d1 = sign((px, py), a, b)
    d2 = sign((px, py), b, c)
    d3 = sign((px, py), c, a)
    neg = (d1 < 0) or (d2 < 0) or (d3 < 0)
    pos = (d1 > 0) or (d2 > 0) or (d3 > 0)
    return not (neg and pos)


def sample(u, v):
    """返回归一化坐标 (u,v) 处的 RGBA，其中 alpha 为 0~1 的浮点"""
    px = (0.0, 0.0, 0.0, 0.0)  # 透明底

    # 1) 两只小角
    if in_triangle(u, v, (0.235, 0.215), (0.300, 0.035), (0.385, 0.165)):
        px = blend(px, HORN, 1.0)
    if in_triangle(u, v, (0.765, 0.215), (0.700, 0.035), (0.615, 0.165)):
        px = blend(px, HORN, 1.0)

    # 2) 圆滚滚的头 / 身体（带上下渐变）
    if in_ellipse(u, v, 0.5, 0.57, 0.455, 0.415):
        t = max(0.0, min(1.0, (v - 0.17) / 0.82))
        body = tuple(int(round(YELLOW_TOP[i] + (YELLOW_BOTTOM[i] - YELLOW_TOP[i]) * t)) for i in range(3))
        px = blend(px, body, 1.0)

    # 3) 肚皮（浅色）
    if in_ellipse(u, v, 0.5, 0.78, 0.245, 0.155):
        px = blend(px, BELLY, 0.9)

    # 4) 大眼睛（白眼球 + 深色瞳孔 + 高光）
    for cx in (0.355, 0.645):
        if in_ellipse(u, v, cx, 0.50, 0.105, 0.125):
            px = blend(px, WHITE, 1.0)
    for cx in (0.368, 0.658):
        if in_ellipse(u, v, cx, 0.525, 0.052, 0.060):
            px = blend(px, PUPIL, 1.0)
    for (hx, hy) in ((0.352, 0.492), (0.642, 0.492)):
        if in_ellipse(u, v, hx, hy, 0.022, 0.024):
            px = blend(px, WHITE, 1.0)

    # 5) 腮红
    if in_ellipse(u, v, 0.205, 0.685, 0.075, 0.045):
        px = blend(px, CHEEK, 0.75)
    if in_ellipse(u, v, 0.795, 0.685, 0.075, 0.045):
        px = blend(px, CHEEK, 0.75)

    # 6) 微笑的嘴（一段圆弧）
    d = math.hypot(u - 0.5, v - 0.63)
    if 0.085 <= d <= 0.115 and v >= 0.63:
        px = blend(px, MOUTH, 1.0)

    return px


def render(size):
    """渲染一张 size x size 的 RGBA 像素数组"""
    rows = []
    n = size * SS
    for y in range(size):
        row = []
        for x in range(size):
            r = g = b = a = 0.0
            for sy in range(SS):
                for sx in range(SS):
                    u = (x * SS + sx + 0.5) / n
                    v = (y * SS + sy + 0.5) / n
                    c = sample(u, v)
                    r += c[0] * c[3]
                    g += c[1] * c[3]
                    b += c[2] * c[3]
                    a += c[3]
            total = SS * SS
            if a > 0:
                # 颜色 = 加权平均；alpha = 覆盖率
                px = (int(round(r / a)), int(round(g / a)), int(round(b / a)),
                      int(round(min(1.0, a / total) * 255)))
                row.append(tuple(max(0, min(255, c)) for c in px))
            else:
                row.append((0, 0, 0, 0))
        rows.append(row)
    return rows


def write_png(path, rows):
    size = len(rows)
    raw = b''
    for row in rows:
        raw += b'\x00' + b''.join(struct.pack('4B', *px) for px in row)

    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data +
                struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF))

    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))  # 8bit RGBA
    png += chunk(b'IDAT', zlib.compress(raw, 9))
    png += chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(png)


def main():
    base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out_dir = os.path.join(base, 'icons')
    if not os.path.isdir(out_dir):
        os.makedirs(out_dir)
    for size in (16, 48, 128):
        path = os.path.join(out_dir, 'icon%d.png' % size)
        write_png(path, render(size))
        print('已生成 %s' % path)


if __name__ == '__main__':
    main()
