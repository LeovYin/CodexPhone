import { chromium } from "@playwright/test";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const brand = path.join(root, "assets/brand");
await mkdir(brand, { recursive: true });
const mark = '<rect x="16" y="16" width="480" height="480" rx="112" fill="#315FCA"/><path d="m112 166 82 82-82 82m116-82h54" fill="none" stroke="#fff" stroke-width="34" stroke-linecap="round" stroke-linejoin="round"/><rect x="296" y="122" width="108" height="268" rx="26" fill="none" stroke="#8EE6C4" stroke-width="26"/><path d="M335 351h30" stroke="#8EE6C4" stroke-width="16" stroke-linecap="round"/>';
const icon = '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><title>CodexPhone</title>' + mark + '</svg>';
const banner = '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="560" viewBox="0 0 1280 560">' +
  '<title>CodexPhone — 同一个任务，从电脑到手机。</title>' +
  '<rect width="1280" height="560" rx="24" fill="#F4F7FF"/><circle cx="1110" cy="295" r="248" fill="#E8EFFD"/>' +
  '<g transform="translate(76 62) scale(.14)">' + mark + '</g>' +
  '<g font-family="Segoe UI,Microsoft YaHei,sans-serif" fill="#142449">' +
  '<text x="166" y="117" font-size="43" font-weight="700">CodexPhone</text>' +
  '<text x="80" y="243" font-size="53" font-weight="700">同一个任务，</text><text x="80" y="315" font-size="53" font-weight="700">从电脑到手机。</text>' +
  '<text x="83" y="375" font-size="22" fill="#526381">随时继续你的 Codex 对话。</text>' +
  '<text x="83" y="473" font-size="18" fill="#526381">Windows EXE</text><circle cx="253" cy="467" r="3" fill="#8CA2CB"/><text x="276" y="473" font-size="18" fill="#526381">Tailscale</text><circle cx="391" cy="467" r="3" fill="#8CA2CB"/><text x="414" y="473" font-size="18" fill="#526381">MIT 开源</text></g>' +
  '<g transform="translate(745 152)"><rect width="355" height="229" rx="18" fill="#142449"/><rect x="10" y="10" width="335" height="204" rx="9" fill="#fff"/><path d="M142 229v28m-42 0h126" fill="none" stroke="#142449" stroke-width="12" stroke-linecap="round"/>' +
  '<circle cx="31" cy="31" r="4" fill="#D6DFED"/><circle cx="46" cy="31" r="4" fill="#D6DFED"/><circle cx="61" cy="31" r="4" fill="#D6DFED"/>' +
  '<path d="m35 65 13 13-13 13m25 0h20" fill="none" stroke="#315FCA" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>' +
  '<rect x="33" y="112" width="211" height="10" rx="5" fill="#DCE6F8"/><rect x="33" y="137" width="154" height="10" rx="5" fill="#DCE6F8"/><rect x="33" y="174" width="109" height="16" rx="8" fill="#8EE6C4"/>' +
  '<path d="M230 167c55 0 27 72 86 72" fill="none" stroke="#315FCA" stroke-width="9" stroke-linecap="round"/>' +
  '<g transform="translate(303 99)"><rect width="112" height="218" rx="24" fill="#315FCA"/><rect x="8" y="9" width="96" height="199" rx="17" fill="#fff"/><rect x="39" y="15" width="34" height="7" rx="3.5" fill="#315FCA"/><rect x="20" y="49" width="72" height="8" rx="4" fill="#DCE6F8"/><rect x="20" y="70" width="58" height="8" rx="4" fill="#DCE6F8"/><rect x="20" y="101" width="69" height="38" rx="10" fill="#E8EFFD"/><path d="m31 118 7 7 14-15" fill="none" stroke="#315FCA" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><rect x="20" y="159" width="72" height="25" rx="11" fill="#8EE6C4"/><path d="M48 198h17" stroke="#315FCA" stroke-width="4" stroke-linecap="round"/></g></g></svg>';
await writeFile(path.join(brand, "icon.svg"), icon);
await writeFile(path.join(brand, "banner.svg"), banner);
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const frames = [];
  for (const size of [16, 24, 32, 48, 64, 128, 256, 512]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent('<style>html,body{margin:0;background:transparent}svg{display:block;width:100%;height:100%}</style>' + icon);
    const png = await page.screenshot({ omitBackground: true });
    await writeFile(path.join(brand, "icon-" + size + ".png"), png);
    if (size <= 256) frames.push({ size, png });
  }
  const header = Buffer.alloc(6 + frames.length * 16); header.writeUInt16LE(1, 2); header.writeUInt16LE(frames.length, 4);
  let offset = header.length;
  frames.forEach(({ size, png }, index) => {
    const i = 6 + index * 16; header[i] = size === 256 ? 0 : size; header[i + 1] = header[i];
    header.writeUInt16LE(1, i + 4); header.writeUInt16LE(32, i + 6); header.writeUInt32LE(png.length, i + 8); header.writeUInt32LE(offset, i + 12); offset += png.length;
  });
  await writeFile(path.join(brand, "codexphone.ico"), Buffer.concat([header, ...frames.map(f => f.png)]));
  await page.setViewportSize({ width: 1280, height: 560 });
  await page.setContent('<style>html,body{margin:0}svg{display:block}</style>' + banner);
  await writeFile(path.join(brand, "banner.png"), await page.screenshot({ omitBackground: true }));
  await mkdir(path.join(root, "apps/web/public/icons"), { recursive: true });
  await writeFile(path.join(root, "apps/web/public/icons/icon.svg"), icon);
  for (const size of [192, 512, 180]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent('<style>html,body{margin:0}svg{display:block;width:100%;height:100%}</style>' + icon);
    await page.screenshot({ path: path.join(root, "apps/web/public/icons/icon-" + size + ".png"), omitBackground: true });
  }
} finally { await browser.close(); }
console.log("Brand assets generated: SVG, PNG, multi-size Windows ICO, web icons.");
