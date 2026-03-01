#!/usr/bin/env node

/**
 * 套装图智能边框裁切脚本（自适应边框颜色）
 *
 * 作用：
 * - 从整张套装图中自动识别 2x4 装备格边框，并裁切出 8 张装备图。
 * - 支持边框为任意颜色（不再限定橙色）。
 * - 输出到 `client/public/assets/images/set-{setName}/`。
 *
 * 不做什么：
 * - 不提供均等切分、透明度切分模式。
 * - 不负责生成素材图，只负责基于边框进行切图。
 *
 * 输入/输出：
 * - 输入：`node scripts/split-set-image.js <setName> <imagePathOrUrl> [--include-border] [--debug-mask]`
 * - 输出：8 张 WebP，命名格式如 `01-weapon-set-{setName}-weapon.webp`。
 *
 * 数据流/状态流：
 * 1. 读取图片并转 raw RGBA。
 * 2. 从“高对比边缘像素”中统计候选边框主色，生成多组边框 profile。
 * 3. 对每个 profile 生成掩码并做连通域，选出最稳定的 2x4 网格。
 * 4. 按网格裁切，并基于已选 profile 做二次/三次修边去残留。
 *
 * 关键边界条件与坑点：
 * - 若边框与背景几乎同色、或边框断裂过重，可能无法识别出 8 个格子，会抛错。
 * - profile 选优是启发式，极端素材建议配合 `--debug-mask` 观察检测结果。
 */

import sharp from 'sharp';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import http from 'http';
import https from 'https';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const GRID_ROWS = 2;
const GRID_COLS = 4;
const EQUIPMENT_ORDER = [
  { index: '01', type: 'weapon', label: '武器' },
  { index: '02', type: 'head', label: '头盔' },
  { index: '03', type: 'clothes', label: '衣服' },
  { index: '04', type: 'gloves', label: '手套' },
  { index: '05', type: 'pants', label: '裤子' },
  { index: '06', type: 'necklace', label: '项链' },
  { index: '07', type: 'accessory', label: '戒指' },
  { index: '08', type: 'artifact', label: '法宝' },
];
const OUTPUT_IMAGE_EXT = 'webp';
const OUTPUT_WEBP_OPTIONS = {
  quality: 82,
  effort: 6,
};

/**
 * @typedef {{
 *  minX: number;
 *  minY: number;
 *  maxX: number;
 *  maxY: number;
 *  area: number;
 *  width: number;
 *  height: number;
 *  fillRatio: number;
 *  cx: number;
 *  cy: number;
 * }} BorderBox
 */

/**
 * @typedef {{
 *  kind: 'palette';
 *  r: number;
 *  g: number;
 *  b: number;
 *  maxDistance: number;
 *  support: number;
 * } | {
 *  kind: 'warm-fallback';
 * }} BorderProfile
 */

function parseArgs(argv) {
  const flags = new Set(argv.filter((arg) => arg.startsWith('--')));
  const positional = argv.filter((arg) => !arg.startsWith('--'));
  const [setName, imageInput] = positional;

  if (!setName || !imageInput) {
    console.error('错误：缺少必填参数。');
    console.log('用法：node scripts/split-set-image.js <setName> <imagePathOrUrl> [--include-border] [--debug-mask]');
    console.log('示例：node scripts/split-set-image.js pojun ./set-pojun-sheet.png');
    process.exit(1);
  }

  return {
    setName,
    imageInput,
    includeBorder: flags.has('--include-border'),
    debugMask: flags.has('--debug-mask'),
  };
}

function isHttpUrl(input) {
  try {
    const url = new URL(input);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function downloadImage(url) {
  return new Promise((resolvePromise, reject) => {
    const transport = url.startsWith('https://') ? https : http;

    transport
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`下载失败，HTTP 状态码：${res.statusCode}`));
          return;
        }

        /** @type {Buffer[]} */
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolvePromise(Buffer.concat(chunks)));
        res.on('error', reject);
      })
      .on('error', reject);
  });
}

async function loadImageBuffer(imageInput) {
  if (isHttpUrl(imageInput)) {
    console.log(`从远程地址下载图片：${imageInput}`);
    const buffer = await downloadImage(imageInput);
    console.log(`下载完成，大小 ${(buffer.length / 1024).toFixed(2)} KB`);
    return buffer;
  }

  const localPath = resolve(imageInput);
  if (!existsSync(localPath)) {
    throw new Error(`本地图片不存在：${localPath}`);
  }

  console.log(`读取本地图片：${localPath}`);
  return readFileSync(localPath);
}

function rgbToHsv(r, g, b) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;

  let h = 0;
  if (delta !== 0) {
    if (max === rn) {
      h = ((gn - bn) / delta) % 6;
    } else if (max === gn) {
      h = (bn - rn) / delta + 2;
    } else {
      h = (rn - gn) / delta + 4;
    }
    h *= 60;
    if (h < 0) h += 360;
  }

  const s = max === 0 ? 0 : delta / max;
  const v = max;
  return { h, s, v };
}

function colorDistanceL1(r1, g1, b1, r2, g2, b2) {
  return Math.abs(r1 - r2) + Math.abs(g1 - g2) + Math.abs(b1 - b2);
}

function isWarmFallbackPixel(r, g, b, a) {
  if (a < 20) return false;
  const { h, s, v } = rgbToHsv(r, g, b);
  const hsvMatch = h >= 10 && h <= 58 && s >= 0.22 && v >= 0.35;
  const rgbMatch = r >= 120 && g >= 70 && r > g && g >= b && r - b >= 26;
  return hsvMatch || rgbMatch;
}

function isEdgeLikePixel(pixelData, imageWidth, imageHeight, channels, x, y) {
  if (x <= 0 || x >= imageWidth - 1 || y <= 0 || y >= imageHeight - 1) {
    return false;
  }

  const idx = (y * imageWidth + x) * channels;
  const r = pixelData[idx];
  const g = pixelData[idx + 1];
  const b = pixelData[idx + 2];
  const a = pixelData[idx + 3];

  if (a < 20) return false;

  const leftIdx = (y * imageWidth + (x - 1)) * channels;
  const rightIdx = (y * imageWidth + (x + 1)) * channels;
  const topIdx = ((y - 1) * imageWidth + x) * channels;
  const bottomIdx = ((y + 1) * imageWidth + x) * channels;

  const diffLeft = colorDistanceL1(r, g, b, pixelData[leftIdx], pixelData[leftIdx + 1], pixelData[leftIdx + 2]);
  const diffRight = colorDistanceL1(r, g, b, pixelData[rightIdx], pixelData[rightIdx + 1], pixelData[rightIdx + 2]);
  const diffTop = colorDistanceL1(r, g, b, pixelData[topIdx], pixelData[topIdx + 1], pixelData[topIdx + 2]);
  const diffBottom = colorDistanceL1(r, g, b, pixelData[bottomIdx], pixelData[bottomIdx + 1], pixelData[bottomIdx + 2]);

  return Math.max(diffLeft, diffRight, diffTop, diffBottom) >= 44;
}

function describeBorderProfile(profile) {
  if (profile.kind === 'warm-fallback') {
    return '暖色兜底 profile';
  }

  return `自适应主色 profile rgb(${profile.r}, ${profile.g}, ${profile.b}), distance<=${profile.maxDistance}`;
}

function isBorderPixelByProfile(profile, r, g, b, a) {
  if (profile.kind === 'warm-fallback') {
    return isWarmFallbackPixel(r, g, b, a);
  }

  if (a < 20) return false;
  return colorDistanceL1(r, g, b, profile.r, profile.g, profile.b) <= profile.maxDistance;
}

function buildColorCandidateProfiles(pixelData, imageWidth, imageHeight, channels) {
  const bucketStep = 16;
  const minSupport = Math.max(70, Math.floor((imageWidth * imageHeight) / 18000));

  /** @type {Map<string, {count: number; sumR: number; sumG: number; sumB: number}>} */
  const buckets = new Map();

  for (let y = 1; y < imageHeight - 1; y += 1) {
    for (let x = 1; x < imageWidth - 1; x += 1) {
      if (!isEdgeLikePixel(pixelData, imageWidth, imageHeight, channels, x, y)) {
        continue;
      }

      const idx = (y * imageWidth + x) * channels;
      const r = pixelData[idx];
      const g = pixelData[idx + 1];
      const b = pixelData[idx + 2];

      const rq = Math.floor(r / bucketStep);
      const gq = Math.floor(g / bucketStep);
      const bq = Math.floor(b / bucketStep);
      const key = `${rq}|${gq}|${bq}`;

      const current = buckets.get(key);
      if (current) {
        current.count += 1;
        current.sumR += r;
        current.sumG += g;
        current.sumB += b;
      } else {
        buckets.set(key, { count: 1, sumR: r, sumG: g, sumB: b });
      }
    }
  }

  const sortedBuckets = [...buckets.values()]
    .filter((entry) => entry.count >= minSupport)
    .sort((a, b) => b.count - a.count);

  /** @type {Array<{r: number; g: number; b: number; count: number}>} */
  const selectedColors = [];
  const maxBaseColors = 8;

  for (const entry of sortedBuckets) {
    const r = Math.round(entry.sumR / entry.count);
    const g = Math.round(entry.sumG / entry.count);
    const b = Math.round(entry.sumB / entry.count);

    const duplicate = selectedColors.some((color) => colorDistanceL1(color.r, color.g, color.b, r, g, b) < 42);
    if (duplicate) {
      continue;
    }

    selectedColors.push({ r, g, b, count: entry.count });
    if (selectedColors.length >= maxBaseColors) {
      break;
    }
  }

  /** @type {BorderProfile[]} */
  const profiles = [];
  for (const color of selectedColors) {
    profiles.push({ kind: 'palette', r: color.r, g: color.g, b: color.b, maxDistance: 44, support: color.count });
    profiles.push({ kind: 'palette', r: color.r, g: color.g, b: color.b, maxDistance: 64, support: color.count });
  }

  profiles.push({ kind: 'warm-fallback' });
  return profiles;
}

function buildMaskByProfile(pixelData, imageWidth, imageHeight, channels, profile) {
  const mask = new Uint8Array(imageWidth * imageHeight);

  for (let y = 0; y < imageHeight; y += 1) {
    for (let x = 0; x < imageWidth; x += 1) {
      const idx = (y * imageWidth + x) * channels;
      const r = pixelData[idx];
      const g = pixelData[idx + 1];
      const b = pixelData[idx + 2];
      const a = pixelData[idx + 3];

      if (isBorderPixelByProfile(profile, r, g, b, a)) {
        mask[y * imageWidth + x] = 1;
      }
    }
  }

  return mask;
}

function denoiseMask(mask, width, height) {
  const output = new Uint8Array(width * height);
  const minNeighbors = 2;

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const idx = y * width + x;
      if (mask[idx] === 0) continue;

      let neighbors = 0;
      for (let ny = y - 1; ny <= y + 1; ny += 1) {
        for (let nx = x - 1; nx <= x + 1; nx += 1) {
          if (nx === x && ny === y) continue;
          if (mask[ny * width + nx] === 1) neighbors += 1;
        }
      }

      if (neighbors >= minNeighbors) {
        output[idx] = 1;
      }
    }
  }

  return output;
}

function mergeBoxes(a, b) {
  const minX = Math.min(a.minX, b.minX);
  const minY = Math.min(a.minY, b.minY);
  const maxX = Math.max(a.maxX, b.maxX);
  const maxY = Math.max(a.maxY, b.maxY);
  const area = a.area + b.area;
  const width = maxX - minX + 1;
  const height = maxY - minY + 1;

  return {
    minX,
    minY,
    maxX,
    maxY,
    area,
    width,
    height,
    fillRatio: area / (width * height),
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2,
  };
}

function shouldMergeBox(a, b) {
  const margin = Math.max(4, Math.round(Math.min(a.width, a.height, b.width, b.height) * 0.12));

  const intersects =
    !(a.maxX + margin < b.minX || b.maxX + margin < a.minX || a.maxY + margin < b.minY || b.maxY + margin < a.minY);

  if (!intersects) return false;

  const centerDistanceX = Math.abs(a.cx - b.cx);
  const centerDistanceY = Math.abs(a.cy - b.cy);
  const distanceLimitX = Math.max(a.width, b.width) * 0.75;
  const distanceLimitY = Math.max(a.height, b.height) * 0.75;

  return centerDistanceX <= distanceLimitX && centerDistanceY <= distanceLimitY;
}

function extractConnectedComponents(mask, width, height) {
  const visited = new Uint8Array(width * height);
  /** @type {BorderBox[]} */
  const components = [];

  const neighbors = [
    [-1, -1], [0, -1], [1, -1],
    [-1, 0],            [1, 0],
    [-1, 1],  [0, 1],  [1, 1],
  ];

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const startIdx = y * width + x;
      if (mask[startIdx] === 0 || visited[startIdx] === 1) continue;

      let minX = x;
      let minY = y;
      let maxX = x;
      let maxY = y;
      let area = 0;

      /** @type {Array<[number, number]>} */
      const queue = [[x, y]];
      visited[startIdx] = 1;

      while (queue.length > 0) {
        const current = queue.pop();
        if (!current) break;
        const [cx, cy] = current;

        area += 1;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;

        for (const [dx, dy] of neighbors) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;

          const nIdx = ny * width + nx;
          if (mask[nIdx] === 0 || visited[nIdx] === 1) continue;

          visited[nIdx] = 1;
          queue.push([nx, ny]);
        }
      }

      const boxWidth = maxX - minX + 1;
      const boxHeight = maxY - minY + 1;
      components.push({
        minX,
        minY,
        maxX,
        maxY,
        area,
        width: boxWidth,
        height: boxHeight,
        fillRatio: area / (boxWidth * boxHeight),
        cx: (minX + maxX) / 2,
        cy: (minY + maxY) / 2,
      });
    }
  }

  return components;
}

function filterCandidateBoxes(components, imageWidth, imageHeight) {
  const minWidth = Math.max(28, Math.floor(imageWidth * 0.08));
  const minHeight = Math.max(28, Math.floor(imageHeight * 0.12));
  const maxWidth = Math.floor(imageWidth * 0.45);
  const maxHeight = Math.floor(imageHeight * 0.65);

  return components.filter((box) => {
    if (box.width < minWidth || box.height < minHeight) return false;
    if (box.width > maxWidth || box.height > maxHeight) return false;

    const aspect = box.width / box.height;
    if (aspect < 0.45 || aspect > 2.2) return false;

    if (box.fillRatio < 0.004 || box.fillRatio > 0.35) return false;

    return true;
  });
}

function extractCandidateBoxesFromMask(mask, width, height) {
  const components = extractConnectedComponents(mask, width, height);
  const filtered = filterCandidateBoxes(components, width, height);
  const merged = mergeFragmentedBoxes(filtered);
  return filterCandidateBoxes(merged, width, height);
}

function mergeFragmentedBoxes(boxes) {
  const sorted = [...boxes].sort((a, b) => b.area - a.area);
  /** @type {BorderBox[]} */
  const merged = [];

  for (const box of sorted) {
    let mergedTargetIndex = -1;

    for (let i = 0; i < merged.length; i += 1) {
      if (shouldMergeBox(merged[i], box)) {
        mergedTargetIndex = i;
        break;
      }
    }

    if (mergedTargetIndex >= 0) {
      merged[mergedTargetIndex] = mergeBoxes(merged[mergedTargetIndex], box);
    } else {
      merged.push(box);
    }
  }

  return merged;
}

function standardDeviation(values) {
  if (values.length === 0) return 0;
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) * (v - mean), 0) / values.length;
  return Math.sqrt(variance);
}

function scoreGrid(boxes) {
  if (boxes.length !== GRID_ROWS * GRID_COLS) return Number.POSITIVE_INFINITY;

  const sortedByY = [...boxes].sort((a, b) => a.cy - b.cy);
  const topRow = sortedByY.slice(0, GRID_COLS);
  const bottomRow = sortedByY.slice(GRID_COLS);

  const topMaxY = Math.max(...topRow.map((box) => box.cy));
  const bottomMinY = Math.min(...bottomRow.map((box) => box.cy));
  if (topMaxY >= bottomMinY) return Number.POSITIVE_INFINITY;

  const topSorted = [...topRow].sort((a, b) => a.cx - b.cx);
  const bottomSorted = [...bottomRow].sort((a, b) => a.cx - b.cx);

  for (let i = 0; i < GRID_COLS - 1; i += 1) {
    if (topSorted[i].cx >= topSorted[i + 1].cx) return Number.POSITIVE_INFINITY;
    if (bottomSorted[i].cx >= bottomSorted[i + 1].cx) return Number.POSITIVE_INFINITY;
  }

  const rowSpread = standardDeviation(topSorted.map((box) => box.cy)) + standardDeviation(bottomSorted.map((box) => box.cy));
  const colAlign = topSorted.reduce((sum, box, index) => sum + Math.abs(box.cx - bottomSorted[index].cx), 0);

  const widths = boxes.map((box) => box.width);
  const heights = boxes.map((box) => box.height);
  const sizeSpread = standardDeviation(widths) + standardDeviation(heights);

  const rowGap = bottomSorted[0].cy - topSorted[0].cy;
  if (rowGap <= 0) return Number.POSITIVE_INFINITY;

  return rowSpread * 2 + colAlign * 0.35 + sizeSpread * 0.6 + 1200 / rowGap;
}

function chooseBestGridBoxes(candidateBoxes) {
  if (candidateBoxes.length < GRID_ROWS * GRID_COLS) {
    throw new Error(`边框候选不足：检测到 ${candidateBoxes.length} 个候选框，至少需要 8 个。`);
  }

  const sortedByArea = [...candidateBoxes].sort((a, b) => b.area - a.area);
  const maxPoolSize = Math.min(12, sortedByArea.length);
  const pool = sortedByArea.slice(0, maxPoolSize);

  /** @type {BorderBox[] | null} */
  let bestSubset = null;
  let bestScore = Number.POSITIVE_INFINITY;

  function dfs(start, picked) {
    if (picked.length === GRID_ROWS * GRID_COLS) {
      const score = scoreGrid(picked);
      if (score < bestScore) {
        bestScore = score;
        bestSubset = [...picked];
      }
      return;
    }

    const remainNeeded = GRID_ROWS * GRID_COLS - picked.length;
    const remainAvailable = maxPoolSize - start;
    if (remainAvailable < remainNeeded) return;

    for (let i = start; i < maxPoolSize; i += 1) {
      picked.push(pool[i]);
      dfs(i + 1, picked);
      picked.pop();
    }
  }

  dfs(0, []);

  if (!bestSubset || !Number.isFinite(bestScore)) {
    throw new Error('无法从候选框中构建稳定的 2x4 网格，请检查边框清晰度。');
  }

  return bestSubset;
}

function sortBoxesToGridOrder(boxes) {
  const sortedByY = [...boxes].sort((a, b) => a.cy - b.cy);
  const topRow = sortedByY.slice(0, GRID_COLS).sort((a, b) => a.cx - b.cx);
  const bottomRow = sortedByY.slice(GRID_COLS).sort((a, b) => a.cx - b.cx);
  return [...topRow, ...bottomRow];
}

function toExtractRegion(box, imageWidth, imageHeight, includeBorder) {
  const shrinkX = includeBorder ? 0 : Math.max(2, Math.round(box.width * 0.012));
  const shrinkY = includeBorder ? 0 : Math.max(2, Math.round(box.height * 0.012));

  const left = Math.max(0, box.minX + shrinkX);
  const top = Math.max(0, box.minY + shrinkY);
  const right = Math.min(imageWidth - 1, box.maxX - shrinkX);
  const bottom = Math.min(imageHeight - 1, box.maxY - shrinkY);

  const width = Math.max(1, right - left + 1);
  const height = Math.max(1, bottom - top + 1);

  return { left, top, width, height };
}

function measureVerticalBorderEdge(pixelData, imageWidth, channels, profile, x, top, bottom) {
  let borderCount = 0;
  const total = Math.max(1, bottom - top + 1);

  for (let y = top; y <= bottom; y += 1) {
    const idx = (y * imageWidth + x) * channels;
    if (isBorderPixelByProfile(profile, pixelData[idx], pixelData[idx + 1], pixelData[idx + 2], pixelData[idx + 3])) {
      borderCount += 1;
    }
  }

  return {
    borderCount,
    total,
    ratio: borderCount / total,
  };
}

function measureHorizontalBorderEdge(pixelData, imageWidth, channels, profile, y, left, right) {
  let borderCount = 0;
  const total = Math.max(1, right - left + 1);

  for (let x = left; x <= right; x += 1) {
    const idx = (y * imageWidth + x) * channels;
    if (isBorderPixelByProfile(profile, pixelData[idx], pixelData[idx + 1], pixelData[idx + 2], pixelData[idx + 3])) {
      borderCount += 1;
    }
  }

  return {
    borderCount,
    total,
    ratio: borderCount / total,
  };
}

function countHorizontalBorderSegment(pixelData, imageWidth, channels, profile, y, startX, endX) {
  let borderCount = 0;
  for (let x = startX; x <= endX; x += 1) {
    const idx = (y * imageWidth + x) * channels;
    if (isBorderPixelByProfile(profile, pixelData[idx], pixelData[idx + 1], pixelData[idx + 2], pixelData[idx + 3])) {
      borderCount += 1;
    }
  }
  return borderCount;
}

function countVerticalBorderSegment(pixelData, imageWidth, channels, profile, x, startY, endY) {
  let borderCount = 0;
  for (let y = startY; y <= endY; y += 1) {
    const idx = (y * imageWidth + x) * channels;
    if (isBorderPixelByProfile(profile, pixelData[idx], pixelData[idx + 1], pixelData[idx + 2], pixelData[idx + 3])) {
      borderCount += 1;
    }
  }
  return borderCount;
}

function computeTrimLimit(length, ratio, minLimit, maxLimit) {
  const scaled = Math.round(length * ratio);
  return Math.max(minLimit, Math.min(maxLimit, scaled));
}

function shouldFineTrimEdge(edge, minRatio, minPixelRatio, minPixelsFloor) {
  const minPixels = Math.max(minPixelsFloor, Math.round(edge.total * minPixelRatio));
  return edge.ratio >= minRatio && edge.borderCount >= minPixels;
}

function isCornerBorderStrong(borderCount, sampleTotal, minRatio, minPixelsFloor) {
  const minPixels = Math.max(minPixelsFloor, Math.round(sampleTotal * minRatio));
  return borderCount >= minPixels;
}

function estimateBackgroundColor(pixelData, imageWidth, channels, region) {
  const { left, top, width, height } = region;
  const right = left + width - 1;
  const bottom = top + height - 1;

  const inset = Math.max(1, Math.min(6, Math.floor(Math.min(width, height) * 0.08)));
  const patchRadius = 1;
  const points = [
    [left + inset, top + inset],
    [right - inset, top + inset],
    [left + inset, bottom - inset],
    [right - inset, bottom - inset],
  ];

  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let sumA = 0;
  let count = 0;

  for (const [px, py] of points) {
    for (let dy = -patchRadius; dy <= patchRadius; dy += 1) {
      for (let dx = -patchRadius; dx <= patchRadius; dx += 1) {
        const sx = Math.min(right, Math.max(left, px + dx));
        const sy = Math.min(bottom, Math.max(top, py + dy));
        const idx = (sy * imageWidth + sx) * channels;
        sumR += pixelData[idx];
        sumG += pixelData[idx + 1];
        sumB += pixelData[idx + 2];
        sumA += pixelData[idx + 3];
        count += 1;
      }
    }
  }

  if (count === 0) {
    return { r: 0, g: 0, b: 0, a: 0 };
  }

  return {
    r: Math.round(sumR / count),
    g: Math.round(sumG / count),
    b: Math.round(sumB / count),
    a: Math.round(sumA / count),
  };
}

function buildForegroundMaskByBackground(pixelData, imageWidth, channels, region, background) {
  const { left, top, width, height } = region;
  const mask = new Uint8Array(width * height);
  const minAlpha = Math.min(24, Math.max(6, background.a - 12));
  const bgLuma = background.r + background.g + background.b;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const gx = left + x;
      const gy = top + y;
      const idx = (gy * imageWidth + gx) * channels;
      const r = pixelData[idx];
      const g = pixelData[idx + 1];
      const b = pixelData[idx + 2];
      const a = pixelData[idx + 3];

      if (a <= minAlpha) {
        continue;
      }

      const colorDiff = colorDistanceL1(r, g, b, background.r, background.g, background.b);
      const lumaDiff = Math.abs((r + g + b) - bgLuma);
      const alphaDiff = Math.abs(a - background.a);

      if (colorDiff >= 34 || lumaDiff >= 24 || alphaDiff >= 28) {
        mask[y * width + x] = 1;
      }
    }
  }

  return mask;
}

function shouldKeepForegroundComponent(component) {
  if (component.area < 24) {
    return false;
  }

  if (component.touchedEdgeCount === 0) {
    return true;
  }

  // 允许“主体轻微擦边”的连通域，避免饰品/特效贴边时被误裁。
  const edgeTouchRatio = component.edgeTouchCount / component.area;
  return component.touchedEdgeCount === 1 && component.area >= 120 && edgeTouchRatio <= 0.08;
}

function isolateInnerContentBounds(pixelData, imageWidth, channels, region) {
  const { width, height } = region;
  if (width <= 4 || height <= 4) {
    return null;
  }

  const background = estimateBackgroundColor(pixelData, imageWidth, channels, region);
  const foregroundMask = buildForegroundMaskByBackground(pixelData, imageWidth, channels, region, background);
  const visited = new Uint8Array(width * height);

  const neighbors = [
    [-1, -1], [0, -1], [1, -1],
    [-1, 0],           [1, 0],
    [-1, 1],  [0, 1],  [1, 1],
  ];

  /** @type {Array<{
   *   minX:number;
   *   minY:number;
   *   maxX:number;
   *   maxY:number;
   *   area:number;
   *   edgeTouchCount:number;
   *   touchedEdgeCount:number;
   * }>} */
  const components = [];

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const startIdx = y * width + x;
      if (foregroundMask[startIdx] === 0 || visited[startIdx] === 1) continue;

      let minX = x;
      let minY = y;
      let maxX = x;
      let maxY = y;
      let area = 0;
      let edgeTouchTop = 0;
      let edgeTouchBottom = 0;
      let edgeTouchLeft = 0;
      let edgeTouchRight = 0;
      let edgeTouchCount = 0;

      /** @type {Array<[number, number]>} */
      const queue = [[x, y]];
      visited[startIdx] = 1;

      while (queue.length > 0) {
        const current = queue.pop();
        if (!current) break;
        const [cx, cy] = current;

        area += 1;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;
        if (cy === 0) edgeTouchTop += 1;
        if (cy === height - 1) edgeTouchBottom += 1;
        if (cx === 0) edgeTouchLeft += 1;
        if (cx === width - 1) edgeTouchRight += 1;
        if (cx === 0 || cx === width - 1 || cy === 0 || cy === height - 1) {
          edgeTouchCount += 1;
        }

        for (const [dx, dy] of neighbors) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;

          const nIdx = ny * width + nx;
          if (foregroundMask[nIdx] === 0 || visited[nIdx] === 1) continue;

          visited[nIdx] = 1;
          queue.push([nx, ny]);
        }
      }

      const touchedEdgeCount =
        (edgeTouchTop > 0 ? 1 : 0)
        + (edgeTouchBottom > 0 ? 1 : 0)
        + (edgeTouchLeft > 0 ? 1 : 0)
        + (edgeTouchRight > 0 ? 1 : 0);

      components.push({ minX, minY, maxX, maxY, area, edgeTouchCount, touchedEdgeCount });
    }
  }

  const innerComponents = components.filter(shouldKeepForegroundComponent);
  if (innerComponents.length === 0) {
    return null;
  }

  let minX = width - 1;
  let minY = height - 1;
  let maxX = 0;
  let maxY = 0;

  for (const item of innerComponents) {
    if (item.minX < minX) minX = item.minX;
    if (item.minY < minY) minY = item.minY;
    if (item.maxX > maxX) maxX = item.maxX;
    if (item.maxY > maxY) maxY = item.maxY;
  }

  const marginX = Math.max(1, Math.round(width * 0.01));
  const marginY = Math.max(1, Math.round(height * 0.01));

  const expandedMinX = Math.max(0, minX - marginX);
  const expandedMinY = Math.max(0, minY - marginY);
  const expandedMaxX = Math.min(width - 1, maxX + marginX);
  const expandedMaxY = Math.min(height - 1, maxY + marginY);

  return {
    left: region.left + expandedMinX,
    top: region.top + expandedMinY,
    width: Math.max(1, expandedMaxX - expandedMinX + 1),
    height: Math.max(1, expandedMaxY - expandedMinY + 1),
  };
}

function refineRegionByBorderEdge(pixelData, imageWidth, imageHeight, channels, profile, initialRegion) {
  let left = initialRegion.left;
  let top = initialRegion.top;
  let right = initialRegion.left + initialRegion.width - 1;
  let bottom = initialRegion.top + initialRegion.height - 1;

  const maxTrimX = computeTrimLimit(initialRegion.width, 0.022, 3, 7);
  const maxTrimY = computeTrimLimit(initialRegion.height, 0.022, 3, 7);

  const coarseBorderThreshold = 0.3;
  const fineBorderThreshold = 0.015;
  const fineBorderMinPixelRatio = 0.015;
  const fineBorderMinPixelsFloor = 4;
  const fineMaxTrimX = computeTrimLimit(initialRegion.width, 0.01, 1, 2);
  const fineMaxTrimY = computeTrimLimit(initialRegion.height, 0.01, 1, 2);

  let trimmedLeft = 0;
  while (trimmedLeft < maxTrimX && left < right) {
    const edge = measureVerticalBorderEdge(pixelData, imageWidth, channels, profile, left, top, bottom);
    if (edge.ratio < coarseBorderThreshold) break;
    left += 1;
    trimmedLeft += 1;
  }

  let trimmedRight = 0;
  while (trimmedRight < maxTrimX && left < right) {
    const edge = measureVerticalBorderEdge(pixelData, imageWidth, channels, profile, right, top, bottom);
    if (edge.ratio < coarseBorderThreshold) break;
    right -= 1;
    trimmedRight += 1;
  }

  let trimmedTop = 0;
  while (trimmedTop < maxTrimY && top < bottom) {
    const edge = measureHorizontalBorderEdge(pixelData, imageWidth, channels, profile, top, left, right);
    if (edge.ratio < coarseBorderThreshold) break;
    top += 1;
    trimmedTop += 1;
  }

  let trimmedBottom = 0;
  while (trimmedBottom < maxTrimY && top < bottom) {
    const edge = measureHorizontalBorderEdge(pixelData, imageWidth, channels, profile, bottom, left, right);
    if (edge.ratio < coarseBorderThreshold) break;
    bottom -= 1;
    trimmedBottom += 1;
  }

  // 粗裁后再做小步精修，清理抗锯齿残留。
  let fineLeft = 0;
  while (fineLeft < fineMaxTrimX && left < right) {
    const edge = measureVerticalBorderEdge(pixelData, imageWidth, channels, profile, left, top, bottom);
    if (!shouldFineTrimEdge(edge, fineBorderThreshold, fineBorderMinPixelRatio, fineBorderMinPixelsFloor)) break;
    left += 1;
    fineLeft += 1;
  }

  let fineRight = 0;
  while (fineRight < fineMaxTrimX && left < right) {
    const edge = measureVerticalBorderEdge(pixelData, imageWidth, channels, profile, right, top, bottom);
    if (!shouldFineTrimEdge(edge, fineBorderThreshold, fineBorderMinPixelRatio, fineBorderMinPixelsFloor)) break;
    right -= 1;
    fineRight += 1;
  }

  let fineTop = 0;
  while (fineTop < fineMaxTrimY && top < bottom) {
    const edge = measureHorizontalBorderEdge(pixelData, imageWidth, channels, profile, top, left, right);
    if (!shouldFineTrimEdge(edge, fineBorderThreshold, fineBorderMinPixelRatio, fineBorderMinPixelsFloor)) break;
    top += 1;
    fineTop += 1;
  }

  let fineBottom = 0;
  while (fineBottom < fineMaxTrimY && top < bottom) {
    const edge = measureHorizontalBorderEdge(pixelData, imageWidth, channels, profile, bottom, left, right);
    if (!shouldFineTrimEdge(edge, fineBorderThreshold, fineBorderMinPixelRatio, fineBorderMinPixelsFloor)) break;
    bottom -= 1;
    fineBottom += 1;
  }

  // 角点清理：处理细小拐角残留。
  const cornerPassLimit = 1;
  const cornerMinBorderRatio = 0.24;
  const cornerMinBorderPixelsFloor = 4;
  let cornerPass = 0;
  while (cornerPass < cornerPassLimit && left < right && top < bottom) {
    const spanX = Math.max(6, Math.round((right - left + 1) * 0.08));
    const spanY = Math.max(6, Math.round((bottom - top + 1) * 0.08));
    const rightStartX = Math.max(left, right - spanX + 1);
    const bottomStartY = Math.max(top, bottom - spanY + 1);
    const leftSpanEndX = Math.min(right, left + spanX - 1);
    const topSpanEndY = Math.min(bottom, top + spanY - 1);

    const horizontalSampleTotal = (leftSpanEndX - left + 1) + (right - rightStartX + 1);
    const verticalSampleTotal = (topSpanEndY - top + 1) + (bottom - bottomStartY + 1);

    let changed = false;

    const topCornerBorder =
      countHorizontalBorderSegment(pixelData, imageWidth, channels, profile, top, left, leftSpanEndX)
      + countHorizontalBorderSegment(pixelData, imageWidth, channels, profile, top, rightStartX, right);
    if (isCornerBorderStrong(topCornerBorder, horizontalSampleTotal, cornerMinBorderRatio, cornerMinBorderPixelsFloor) && top < bottom) {
      top += 1;
      changed = true;
    }

    const bottomCornerBorder =
      countHorizontalBorderSegment(pixelData, imageWidth, channels, profile, bottom, left, leftSpanEndX)
      + countHorizontalBorderSegment(pixelData, imageWidth, channels, profile, bottom, rightStartX, right);
    if (isCornerBorderStrong(bottomCornerBorder, horizontalSampleTotal, cornerMinBorderRatio, cornerMinBorderPixelsFloor) && top < bottom) {
      bottom -= 1;
      changed = true;
    }

    const leftCornerBorder =
      countVerticalBorderSegment(pixelData, imageWidth, channels, profile, left, top, topSpanEndY)
      + countVerticalBorderSegment(pixelData, imageWidth, channels, profile, left, bottomStartY, bottom);
    if (isCornerBorderStrong(leftCornerBorder, verticalSampleTotal, cornerMinBorderRatio, cornerMinBorderPixelsFloor) && left < right) {
      left += 1;
      changed = true;
    }

    const rightCornerBorder =
      countVerticalBorderSegment(pixelData, imageWidth, channels, profile, right, top, topSpanEndY)
      + countVerticalBorderSegment(pixelData, imageWidth, channels, profile, right, bottomStartY, bottom);
    if (isCornerBorderStrong(rightCornerBorder, verticalSampleTotal, cornerMinBorderRatio, cornerMinBorderPixelsFloor) && left < right) {
      right -= 1;
      changed = true;
    }

    if (!changed) break;
    cornerPass += 1;
  }

  const safeLeft = Math.max(0, left);
  const safeTop = Math.max(0, top);
  const safeRight = Math.min(imageWidth - 1, right);
  const safeBottom = Math.min(imageHeight - 1, bottom);

  return {
    left: safeLeft,
    top: safeTop,
    width: Math.max(1, safeRight - safeLeft + 1),
    height: Math.max(1, safeBottom - safeTop + 1),
  };
}

function shouldFallbackFromIsolatedRegion(sourceRegion, isolatedRegion) {
  const widthRatio = isolatedRegion.width / sourceRegion.width;
  const heightRatio = isolatedRegion.height / sourceRegion.height;
  const areaRatio = (isolatedRegion.width * isolatedRegion.height) / (sourceRegion.width * sourceRegion.height);

  // 基础兜底：异常极小区域直接判定为误裁。
  if (widthRatio < 0.3 || heightRatio < 0.3) {
    return true;
  }

  // 细长主体只允许单轴明显收缩；若双轴一起缩小，通常是把主体误识别成局部高亮。
  const shrunkOnBothAxes = widthRatio < 0.68 && heightRatio < 0.72;

  // 再加一层面积约束，避免极端素材在单轴临界值附近漏判。
  const aggressiveAreaShrink = areaRatio < 0.42 && (widthRatio < 0.78 || heightRatio < 0.78);

  return shrunkOnBothAxes || aggressiveAreaShrink;
}

function refineRegionByContentIsolation(pixelData, imageWidth, channels, region) {
  const isolated = isolateInnerContentBounds(pixelData, imageWidth, channels, region);
  if (!isolated) {
    return region;
  }

  if (shouldFallbackFromIsolatedRegion(region, isolated)) {
    return region;
  }

  return isolated;
}

async function saveMaskDebugImage(mask, width, height, outputPath) {
  const rgba = Buffer.alloc(width * height * 4);

  for (let i = 0; i < mask.length; i += 1) {
    const v = mask[i] === 1 ? 255 : 0;
    const base = i * 4;
    rgba[base] = v;
    rgba[base + 1] = v;
    rgba[base + 2] = v;
    rgba[base + 3] = 255;
  }

  await sharp(rgba, { raw: { width, height, channels: 4 } }).png().toFile(outputPath);
}

function resolveOutputDir(setName) {
  const projectRoot = resolve(__dirname, '..');
  const outputDir = join(projectRoot, 'client', 'public', 'assets', 'images', `set-${setName}`);

  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  return outputDir;
}

function buildOutputFileName(setName, slot) {
  return `${slot.index}-${slot.type}-set-${setName}-${slot.type}.${OUTPUT_IMAGE_EXT}`;
}

async function saveExtractedEquipmentImage(imageBuffer, extractRegion, outputPath) {
  await sharp(imageBuffer)
    .extract(extractRegion)
    .webp(OUTPUT_WEBP_OPTIONS)
    .toFile(outputPath);
}

function evaluateProfile(pixelData, imageWidth, imageHeight, channels, profile) {
  const rawMask = buildMaskByProfile(pixelData, imageWidth, imageHeight, channels, profile);
  const mask = denoiseMask(rawMask, imageWidth, imageHeight);
  const candidateBoxes = extractCandidateBoxesFromMask(mask, imageWidth, imageHeight);

  if (candidateBoxes.length < GRID_ROWS * GRID_COLS) {
    return null;
  }

  let selected;
  try {
    selected = chooseBestGridBoxes(candidateBoxes);
  } catch {
    return null;
  }

  const gridScore = scoreGrid(selected);
  if (!Number.isFinite(gridScore)) {
    return null;
  }

  const profilePenalty = Math.abs(candidateBoxes.length - GRID_ROWS * GRID_COLS) * 28;
  const finalScore = gridScore + profilePenalty;

  return {
    profile,
    mask,
    score: finalScore,
    candidateCount: candidateBoxes.length,
    boxes: sortBoxesToGridOrder(selected),
  };
}

async function detectGridBoxes(imageBuffer, debugMaskPath) {
  const { data, info } = await sharp(imageBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;

  if (!width || !height) {
    throw new Error('无法读取图片尺寸。');
  }

  const profiles = buildColorCandidateProfiles(data, width, height, channels);

  let bestResult = null;
  for (const profile of profiles) {
    const result = evaluateProfile(data, width, height, channels, profile);
    if (!result) continue;

    if (!bestResult || result.score < bestResult.score) {
      bestResult = result;
    }
  }

  if (!bestResult) {
    throw new Error('边框检测失败：无法识别稳定 2x4 网格。可尝试更清晰素材或使用 --debug-mask 排查。');
  }

  if (debugMaskPath) {
    await saveMaskDebugImage(bestResult.mask, width, height, debugMaskPath);
    console.log(`已输出调试掩码：${debugMaskPath}`);
  }

  return {
    width,
    height,
    channels,
    pixelData: data,
    boxes: bestResult.boxes,
    candidateCount: bestResult.candidateCount,
    borderProfile: bestResult.profile,
  };
}

async function splitSetImageByBorder({ setName, imageInput, includeBorder, debugMask }) {
  console.log(`开始处理套装：${setName}`);
  const imageBuffer = await loadImageBuffer(imageInput);

  const outputDir = resolveOutputDir(setName);
  const debugMaskPath = debugMask ? join(outputDir, `set-${setName}-border-mask.png`) : null;

  const detected = await detectGridBoxes(imageBuffer, debugMaskPath);
  const { width, height, boxes, borderProfile, pixelData, channels, candidateCount } = detected;

  console.log(`图片尺寸：${width} x ${height}`);
  console.log(`检测到边框网格：${boxes.length} 个，候选框：${candidateCount} 个`);
  console.log(`使用边框 profile：${describeBorderProfile(borderProfile)}`);
  console.log(`输出格式：WebP（quality=${OUTPUT_WEBP_OPTIONS.quality}, effort=${OUTPUT_WEBP_OPTIONS.effort}）`);

  for (let i = 0; i < boxes.length; i += 1) {
    const slot = EQUIPMENT_ORDER[i];
    const box = boxes[i];
    const initialRegion = toExtractRegion(box, width, height, includeBorder);
    const borderRefinedRegion = includeBorder
      ? initialRegion
      : refineRegionByBorderEdge(pixelData, width, height, channels, borderProfile, initialRegion);
    const extractRegion = includeBorder
      ? borderRefinedRegion
      : refineRegionByContentIsolation(pixelData, width, channels, borderRefinedRegion);

    const fileName = buildOutputFileName(setName, slot);
    const outputPath = join(outputDir, fileName);

    await saveExtractedEquipmentImage(imageBuffer, extractRegion, outputPath);

    console.log(
      `✓ ${slot.label} -> ${fileName} (left=${extractRegion.left}, top=${extractRegion.top}, width=${extractRegion.width}, height=${extractRegion.height})`,
    );
  }

  console.log(`\n切分完成，输出目录：${outputDir}`);
}

(async function run() {
  try {
    const options = parseArgs(process.argv.slice(2));
    await splitSetImageByBorder(options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`❌ 处理失败：${message}`);
    process.exit(1);
  }
})();
