import { describe, expect, it } from 'vitest';
import {
  applyHomography,
  aspectRatio,
  homography,
  isConvex,
  orderQuad,
  outputSize,
  quadArea,
  warpPerspective,
} from '../../src/core/geometry';
import type { Point, Quad, RGBAImage } from '../../src/core/raster';

/** Project a W x H rectangle lying in a plane through a pinhole camera (y down, like images). */
function project(
  W: number,
  H: number,
  f: number,
  imgW: number,
  imgH: number,
  pose: { rx: number; ry: number; rz: number; tz: number; tx?: number; ty?: number },
): Quad {
  const { rx, ry, rz, tz } = pose;
  const [cx, sx] = [Math.cos(rx), Math.sin(rx)];
  const [cy, sy] = [Math.cos(ry), Math.sin(ry)];
  const [cz, sz] = [Math.cos(rz), Math.sin(rz)];
  const rot = (p: [number, number, number]): [number, number, number] => {
    let [x, y, z] = p;
    [y, z] = [y * cx - z * sx, y * sx + z * cx];
    [x, z] = [x * cy + z * sy, -x * sy + z * cy];
    [x, y] = [x * cz - y * sz, x * sz + y * cz];
    return [x, y, z];
  };
  const corners: [number, number][] = [
    [0, 0],
    [W, 0],
    [W, H],
    [0, H],
  ];
  return corners.map(([X, Y]) => {
    const [x, y, z] = rot([X - W / 2, Y - H / 2, 0]);
    const Z = z + tz;
    return { x: (f * (x + (pose.tx ?? 0))) / Z + imgW / 2, y: (f * (y + (pose.ty ?? 0))) / Z + imgH / 2 };
  }) as Quad;
}

function checkerboard(w: number, h: number, cell: number): RGBAImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 ? 230 : 25;
      const o = (y * w + x) * 4;
      data[o] = data[o + 1] = data[o + 2] = v;
      data[o + 3] = 255;
    }
  return { width: w, height: h, data };
}

describe('homography', () => {
  it('maps each corner onto its target and round-trips through its inverse', () => {
    const a: Quad = [
      { x: 0, y: 0 },
      { x: 3000, y: 0 },
      { x: 3000, y: 4000 },
      { x: 0, y: 4000 },
    ];
    const b: Quad = [
      { x: 412.3, y: 380.1 },
      { x: 2711.9, y: 512.4 },
      { x: 2950.5, y: 3833.2 },
      { x: 201.7, y: 3604.8 },
    ];
    const h = homography(a, b);
    const hi = homography(b, a);
    for (let i = 0; i < 4; i++) {
      const p = applyHomography(h, a[i].x, a[i].y);
      expect(p.x).toBeCloseTo(b[i].x, 6);
      expect(p.y).toBeCloseTo(b[i].y, 6);
    }
    for (const [x, y] of [
      [100, 200],
      [1500, 2000],
      [2999, 17],
      [-50, 4100],
    ]) {
      const p = applyHomography(h, x, y);
      const q = applyHomography(hi, p.x, p.y);
      expect(q.x).toBeCloseTo(x, 6);
      expect(q.y).toBeCloseTo(y, 6);
    }
  });

  it('throws on a degenerate quad', () => {
    const line: Quad = [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 2 },
      { x: 3, y: 3 },
    ];
    expect(() => homography(line, line)).toThrow();
  });
});

describe('warpPerspective', () => {
  it('undoes a perspective projection: a warped checkerboard comes back square and straight', () => {
    const page = checkerboard(240, 320, 20);
    // Photograph it: page -> photo through a tilted pose.
    const photoW = 480;
    const photoH = 640;
    const quad = project(240, 320, 700, photoW, photoH, { rx: 0.35, ry: -0.25, rz: 0.12, tz: 520 });
    const toPage = homography(quad, [
      { x: 0, y: 0 },
      { x: 240, y: 0 },
      { x: 240, y: 320 },
      { x: 0, y: 320 },
    ]);
    const photo = new Uint8ClampedArray(photoW * photoH * 4).fill(128);
    // Render the photo by inverse mapping with 3x3 supersampling.
    for (let y = 0; y < photoH; y++)
      for (let x = 0; x < photoW; x++) {
        let acc = 0;
        let n = 0;
        for (let sy = 0; sy < 3; sy++)
          for (let sx = 0; sx < 3; sx++) {
            const p = applyHomography(toPage, x + (sx + 0.5) / 3, y + (sy + 0.5) / 3);
            if (p.x >= 0 && p.y >= 0 && p.x < 240 && p.y < 320) {
              acc += page.data[((p.y | 0) * 240 + (p.x | 0)) * 4];
              n++;
            } else acc += 128;
          }
        const o = (y * photoW + x) * 4;
        photo.fill(n ? acc / 9 : 128, o, o + 3);
        photo[o + 3] = 255;
      }
    const back = warpPerspective({ width: photoW, height: photoH, data: photo }, quad, 240, 320);
    expect(back.width).toBe(240);
    expect(back.height).toBe(320);
    // Compare cell interiors (away from the 1-2 px of blur at each checker edge).
    let err = 0;
    let n = 0;
    for (let y = 0; y < 320; y++)
      for (let x = 0; x < 240; x++) {
        const dx = x % 20;
        const dy = y % 20;
        if (dx < 3 || dx > 16 || dy < 3 || dy > 16) continue;
        err += Math.abs(back.data[(y * 240 + x) * 4] - page.data[(y * 240 + x) * 4]);
        n++;
      }
    expect(err / n).toBeLessThan(6);
    // Grid lines are straight: the dark/light transition along every column boundary sits at
    // the same x on every row (within a pixel).
    for (let col = 20; col < 240; col += 20) {
      for (let y = 5; y < 320; y += 37) {
        const row = y * 240;
        const left = back.data[(row + col - 2) * 4];
        const right = back.data[(row + col + 1) * 4];
        expect(Math.abs(left - right)).toBeGreaterThan(120);
      }
    }
  });

  it('supersamples a strong downscale instead of aliasing', () => {
    // 1-px stripes shrunk 4x: a correct resample is flat mid-grey; plain bilinear would
    // pick up whichever stripes it happened to land on.
    const w = 800;
    const h = 800;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        data.fill(x % 2 ? 255 : 0, o, o + 3);
        data[o + 3] = 255;
      }
    const quad: Quad = [
      { x: 0, y: 0 },
      { x: w, y: 0 },
      { x: w, y: h },
      { x: 0, y: h },
    ];
    const out = warpPerspective({ width: w, height: h, data }, quad, 200, 200);
    let mean = 0;
    let sq = 0;
    for (let i = 0; i < 200 * 200; i++) {
      const v = out.data[i * 4];
      mean += v;
      sq += v * v;
    }
    mean /= 40000;
    const sd = Math.sqrt(sq / 40000 - mean * mean);
    expect(Math.abs(mean - 127.5)).toBeLessThan(4);
    expect(sd).toBeLessThan(10);
  });
});

describe('aspectRatio / outputSize', () => {
  const imgW = 3024;
  const imgH = 4032;
  const f = 0.85 * imgH; // a typical phone main camera
  const poses = [
    { rx: 0.45, ry: 0.05, rz: 0.02, tz: 5200 },
    { rx: -0.3, ry: 0.35, rz: -0.2, tz: 5600 },
    { rx: 0.2, ry: -0.4, rz: 0.4, tz: 6000 },
    { rx: 0.55, ry: 0.25, rz: 1.5, tz: 6500, tx: 300, ty: -200 },
    { rx: -0.5, ry: -0.2, rz: 3.0, tz: 5000 },
  ];

  it('recovers the true aspect ratio of a Letter page under perspective within 3%', () => {
    for (const pose of poses) {
      const quad = orderQuad(project(2159, 2794, f, imgW, imgH, pose)); // Letter, in tenths of mm
      const r = aspectRatio(quad, imgW, imgH);
      expect(r).not.toBeNull();
      // orderQuad may start the page at a different corner when it is rotated a quarter
      // turn or more, in which case width and height swap.
      const want = 2159 / 2794;
      const got = Math.abs(r! - want) < Math.abs(1 / r! - want) ? r! : 1 / r!;
      expect(Math.abs(got - want) / want).toBeLessThan(0.03);
    }
  });

  it('beats averaging edge lengths, which is what a tilted shot fools', () => {
    const quad = orderQuad(project(2159, 2794, f, imgW, imgH, { rx: 0.6, ry: 0, rz: 0, tz: 4200 }));
    const naive = (Math.hypot(quad[1].x - quad[0].x, quad[1].y - quad[0].y) + Math.hypot(quad[2].x - quad[3].x, quad[2].y - quad[3].y)) /
      (Math.hypot(quad[3].x - quad[0].x, quad[3].y - quad[0].y) + Math.hypot(quad[2].x - quad[1].x, quad[2].y - quad[1].y));
    const want = 2159 / 2794;
    const r = aspectRatio(quad, imgW, imgH)!;
    expect(Math.abs(naive - want) / want).toBeGreaterThan(0.1);
    expect(Math.abs(r - want) / want).toBeLessThan(0.02);
  });

  it('needs no focal length for a parallelogram: the ratio is the edge ratio', () => {
    const quad: Quad = [
      { x: 100, y: 200 },
      { x: 1100, y: 250 },
      { x: 1050, y: 1550 },
      { x: 50, y: 1500 },
    ]; // no vanishing points at all
    const top = Math.hypot(1000, 50);
    const left = Math.hypot(50, 1300);
    expect(aspectRatio(quad, imgW, imgH)).toBeCloseTo(top / left, 4);
    expect(aspectRatio(quad, imgW, imgH, 1000)).toBeCloseTo(top / left, 4);
    const size = outputSize(quad, imgW, imgH, 10000);
    expect(size.width / size.height).toBeCloseTo(top / left, 2);
  });

  it('is tolerant of the assumed focal length when only one pair of edges converges', () => {
    // Tipped forward only: the commonest shot, and the one that gives no focal estimate.
    const quad = orderQuad(project(2159, 2794, f, imgW, imgH, { rx: 0.5, ry: 0, rz: 0, tz: 4500 }));
    const want = 2159 / 2794;
    for (const guess of [0.6, 0.8, 1.0, 1.2]) {
      const r = aspectRatio(quad, imgW, imgH, guess * imgH)!;
      expect(Math.abs(r - want) / want).toBeLessThan(0.12);
    }
    // With the right focal length it is exact.
    expect(Math.abs(aspectRatio(quad, imgW, imgH, f)! - want) / want).toBeLessThan(0.005);
  });

  it('caps the long edge and keeps the near edge resolution', () => {
    const quad = orderQuad(project(2159, 2794, f, imgW, imgH, poses[0]));
    const free = outputSize(quad, imgW, imgH, 100000);
    const cap = Math.round(Math.max(free.width, free.height) * 0.6);
    const capped = outputSize(quad, imgW, imgH, cap);
    expect(Math.max(capped.width, capped.height)).toBe(cap);
    expect(capped.width / capped.height).toBeCloseTo(free.width / free.height, 2);
    const longest = Math.max(
      ...[0, 1, 2, 3].map((i) => Math.hypot(quad[(i + 1) % 4].x - quad[i].x, quad[(i + 1) % 4].y - quad[i].y)),
    );
    // At least the best-sampled edge, and not wildly more.
    expect(Math.max(free.width, free.height)).toBeGreaterThanOrEqual(Math.floor(longest) - 1);
    expect(Math.max(free.width, free.height)).toBeLessThan(longest * 1.6);
  });
});

describe('orderQuad', () => {
  it('orders shuffled corners as TL, TR, BR, BL', () => {
    const want: Point[] = [
      { x: 120, y: 80 },
      { x: 900, y: 140 },
      { x: 860, y: 1200 },
      { x: 60, y: 1100 },
    ];
    const perms = [
      [0, 1, 2, 3],
      [2, 0, 3, 1],
      [3, 2, 1, 0],
      [1, 3, 0, 2],
      [2, 3, 0, 1],
    ];
    for (const p of perms) {
      const q = orderQuad(p.map((i) => want[i]));
      expect(q).toEqual(want);
      expect(isConvex(q)).toBe(true);
      expect(quadArea(q)).toBeGreaterThan(0);
    }
  });

  it('handles a page rotated about 30 degrees', () => {
    const c = { x: 500, y: 500 };
    const a = (30 * Math.PI) / 180;
    const rot = (x: number, y: number): Point => ({
      x: c.x + x * Math.cos(a) - y * Math.sin(a),
      y: c.y + x * Math.sin(a) + y * Math.cos(a),
    });
    const tl = rot(-200, -300);
    const tr = rot(200, -300);
    const br = rot(200, 300);
    const bl = rot(-200, 300);
    const q = orderQuad([br, tl, bl, tr]);
    // Clockwise on screen, starting from the corner nearest the top-left of the frame.
    expect(isConvex(q)).toBe(true);
    expect(q[0]).toEqual(tl.x + tl.y < bl.x + bl.y ? tl : bl);
  });
});
