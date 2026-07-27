"""Generates the Homey app icon and store images from one star definition."""
import math
from PIL import Image, ImageDraw

# ---------------------------------------------------------------- geometry ---

def star_points(cx, cy, r_outer, r_inner, points=5, rot=-math.pi / 2):
    pts = []
    for i in range(points * 2):
        r = r_outer if i % 2 == 0 else r_inner
        a = rot + i * math.pi / points
        pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts


def _round_corner(prev, cur, nxt, radius):
    """Returns (tangent_in, control, tangent_out) for a rounded vertex."""
    def unit(a, b):
        dx, dy = b[0] - a[0], b[1] - a[1]
        d = math.hypot(dx, dy) or 1.0
        return dx / d, dy / d, d

    ux1, uy1, d1 = unit(cur, prev)
    ux2, uy2, d2 = unit(cur, nxt)
    d = min(radius, d1 * 0.5, d2 * 0.5)
    return ((cur[0] + ux1 * d, cur[1] + uy1 * d),
            cur,
            (cur[0] + ux2 * d, cur[1] + uy2 * d))


def rounded_path(pts, radius):
    """Rounded polygon as a list of (tangent_in, control, tangent_out)."""
    n = len(pts)
    return [_round_corner(pts[(i - 1) % n], pts[i], pts[(i + 1) % n], radius)
            for i in range(n)]


def to_svg(pts, radius):
    corners = rounded_path(pts, radius)
    d = [f'M {corners[0][2][0]:.2f} {corners[0][2][1]:.2f}']
    for i in range(1, len(corners) + 1):
        t_in, ctrl, t_out = corners[i % len(corners)]
        d.append(f'L {t_in[0]:.2f} {t_in[1]:.2f}')
        d.append(f'Q {ctrl[0]:.2f} {ctrl[1]:.2f} {t_out[0]:.2f} {t_out[1]:.2f}')
    d.append('Z')
    return ' '.join(d)


def to_polygon(pts, radius, steps=14):
    """Samples the rounded outline into a dense polygon for rasterising."""
    corners = rounded_path(pts, radius)
    out = []
    for i in range(len(corners)):
        t_in, ctrl, t_out = corners[i]
        out.append(t_in)
        for s in range(1, steps + 1):
            t = s / (steps + 1)
            mt = 1 - t
            out.append((mt * mt * t_in[0] + 2 * mt * t * ctrl[0] + t * t * t_out[0],
                        mt * mt * t_in[1] + 2 * mt * t * ctrl[1] + t * t * t_out[1]))
        out.append(t_out)
    return out


# ------------------------------------------------------------------ colours ---

def lerp(c1, c2, t):
    return tuple(round(a + (b - a) * t) for a, b in zip(c1, c2))


def gradient(size, stops, diagonal=True):
    """Multi-stop gradient; diagonal runs top-left to bottom-right."""
    w, h = size
    img = Image.new('RGB', size)
    px = img.load()
    for y in range(h):
        for x in range(w):
            t = ((x / max(w - 1, 1)) + (y / max(h - 1, 1))) / 2 if diagonal else y / max(h - 1, 1)
            for i in range(len(stops) - 1):
                p0, c0 = stops[i]
                p1, c1 = stops[i + 1]
                if p0 <= t <= p1:
                    px[x, y] = lerp(c0, c1, (t - p0) / (p1 - p0 or 1))
                    break
            else:
                px[x, y] = stops[-1][1]
    return img


# --------------------------------------------------------------- star layer ---

R_INNER_RATIO = 0.52     # chunky star, not thin spikes
CORNER_RADIUS = 0.17     # fraction of outer radius
WALL = 0.34              # hole size relative to outer radius


def star_mask(size, cx, cy, r, ss=4):
    """White hollow rounded star as an alpha mask, supersampled."""
    w, h = size
    m = Image.new('L', (w * ss, h * ss), 0)
    d = ImageDraw.Draw(m)

    outer = star_points(cx * ss, cy * ss, r * ss, r * ss * R_INNER_RATIO)
    d.polygon(to_polygon(outer, r * ss * CORNER_RADIUS), fill=255)

    ri = r * (1 - WALL)
    inner = star_points(cx * ss, cy * ss, ri * ss, ri * ss * R_INNER_RATIO)
    d.polygon(to_polygon(inner, ri * ss * CORNER_RADIUS), fill=0)

    return m.resize((w, h), Image.LANCZOS)


def rounded_rect_mask(size, box, radius, ss=4):
    w, h = size
    m = Image.new('L', (w * ss, h * ss), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([box[0] * ss, box[1] * ss, box[2] * ss, box[3] * ss],
                        radius=radius * ss, fill=255)
    return m.resize((w, h), Image.LANCZOS)
