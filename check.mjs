import { chromium, devices } from 'playwright';
import imghash from 'imghash';
import { WebClient } from '@slack/web-api';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

function required(name) {
  const v = process.env[name]; 
  if (!v) {
    throw new Error(`必要な環境変数 [${name}] が設定されていません。`); 
  } 
  return v; 
} 

// 変数の宣言
let LP_URLS = [ ] ; 
let BANNER_URLS = [ ] ;

const YOOM_WEBHOOK_URL = process.env.YOOM_WEBHOOK_URL || '';
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || '';
const SLACK_CHANNEL = process.env.SLACK_CHANNEL || '';
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID || '';
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY || '';
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const S3_BUCKET = process.env.S3_BUCKET || '';
const S3_PREFIX = process.env.S3_PREFIX || '';
const THRESHOLD = parseInt(process.env.MATCH_THRESHOLD || '20', 10);
const S3_ENABLED = AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY && S3_BUCKET;
const OUT_DIR = 'out';
const TMP_DIR = 'tmp';

function hammingHex(a, b) {
  if (a.length !== b.length) return Infinity;
  let dist = 0;
  for (let i = 0; i < a.length; i++) {
    let xor = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (xor) {
      dist += xor & 1;
      xor >>= 1;
    }
  }
  return dist;
}

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let total = 0;
      const step = 200;
      const timer = setInterval(() => {
        window.scrollBy(0, step);
        total += step;
        if (total >= document.body.scrollHeight + 1000) {
          clearInterval(timer);
          resolve(undefined);
        }
      }, 80);
    });
  });
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(500);
}

async function downloadToFile(url, filepath) {
  if (!url.startsWith('http')) {
    const buf = await readFile(url);
    await writeFile(filepath, buf);
    return;
  }
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  await writeFile(filepath, buf);
}

async function hashUrl(url) {
  const tmpPath = path.join(TMP_DIR, `${randomUUID()}.bin`);
  try {
    await downloadToFile(url, tmpPath);
    return await imghash.hash(tmpPath, 8, 'hex');
  }
  catch (e) {
    throw new Error(`Download or Hash failed: ${e.message}`);
  } finally {
    await rm(tmpPath, { force: true });
  }
}

const s3Client = S3_ENABLED ? new S3Client({
  region: AWS_REGION,
  credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY },
}) : null;

async function uploadToS3(filepath, key) {
  const buf = await readFile(filepath);
  await s3Client.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    Body: buf,
    ContentType: 'image/jpeg',
  }));
  return `https://${S3_BUCKET}.s3.${AWS_REGION}.amazonaws.com/${key}`;
}

async function main() {
  LP_URLS = required('LP_URL').split(',').map(url => url.trim());
  BANNER_URLS = required('BANNER_URL').split(',').map(url => url.trim());

  await mkdir(OUT_DIR, { recursive: true }); 
  await mkdir(TMP_DIR, { recursive: true });
  
  // ⚙️ 状況を100%可視化するログ
  console.log("=========================================");
  console.log(`🚀 ターゲットLP:`, LP_URLS);
  console.log(`🚀 照合バナー数: ${BANNER_URLS.length}件`);
  console.log("====== [DEBUG] Slack 環境変数確認 ======");
  console.log("SLACK_BOT_TOKENが存在するか:", SLACK_BOT_TOKEN ? "✅ YES" : "❌ NO (空っぽ)");
  console.log("SLACK_CHANNELが存在するか:", SLACK_CHANNEL ? `✅ YES (${SLACK_CHANNEL})` : "❌ NO (空っぽ)");
  console.log("PARENT_THREAD_TSの値:", process.env.PARENT_THREAD_TS ? `「${process.env.PARENT_THREAD_TS}」` : "❌ 空っぽ（または未設定）");
  console.log("=========================================");

  const banners = [];
  for (let i = 0; i < BANNER_URLS.length; i++) {
    const url = BANNER_URLS[i];
    const bannerPath = path.join(OUT_DIR, `banner_input_${i}.png`);
    await downloadToFile(url, bannerPath);
    const bannerHash = await imghash.hash(bannerPath, 8, 'hex');
    banners.push({ id: i, url, hash: bannerHash });
  }

  const browser = await chromium.launch({
    args: ['--disable-web-security', '--disable-features=IsolateOrigins,site-per-process']
  });
  
  const viewports = [
    { name: 'PC', context: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 } },
    { name: 'SP', context: devices['iPhone 13'] },
  ];

  const allResults = [];
  let totalAllFound = true;

  for (let lpIdx = 0; lpIdx < LP_URLS.length; lpIdx++) {
    const lpUrl = LP_URLS[lpIdx];
    console.log(`Processing LP [${lpIdx + 1}/${LP_URLS.length}]: ${lpUrl}`);

    const results = { PC: {}, SP: {} };
    const screenshots = { PC: {}, SP: {} };

    for (const v of viewports) {
      const ctx = await browser.newContext(v.context);
      const page = await ctx.newPage();

      try {
        await page.goto(lpUrl, { waitUntil: 'load', timeout: 120000 });

        await page.addStyleTag({ content: '[class*="modal"], [class*="popup"], [class*="overlay"], [class*="dialog"] { display: none !important; }' }).catch(() => {});
        await page.locator('text=閉じる').first().click({ timeout: 2000 }).catch(() => {});
        await page.locator('text=×').first().click({ timeout: 2000 }).catch(() => {});

        await autoScroll(page);
        await page.waitForLoadState('networkidle').catch(() => {});

        await page.evaluate(() => document.fonts.ready).catch(() => {});
        await page.waitForTimeout(2000);

        const screenshotPath = path.join(OUT_DIR, `lp_${lpIdx}_${v.name}.jpg`);
        await page.screenshot({ path: screenshotPath, fullPage: true, type: 'jpeg', quality: 85 });

        let screenshotUrl = null;
        if (S3_ENABLED) {
          const ts = new Date().toISOString().replace(/[:.]/g, '-');
          const key = `${S3_PREFIX}${ts}_lp${lpIdx}_${v.name}.jpg`;
          screenshotUrl = await uploadToS3(screenshotPath, key);
        }
        screenshots[v.name] = { path: screenshotPath, url: screenshotUrl };

        const imageSrcs = [];
        for (const frame of page.frames()) {
          try {
            const srcs = await frame.evaluate(() => Array.from(document.querySelectorAll('img'))
              .filter((img) => img.complete && img.naturalWidth > 0)
              .map((img) => img.currentSrc || img.src)
              .filter((src) => src && !src.startsWith('data:'))
            );
