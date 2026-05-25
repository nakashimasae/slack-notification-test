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
    console.error(`Missing required env: ${name}`);
    process.exit(2);
  }
  return v;
}

// ⭐ LP URLもカンマ区切りで配列に変換
const LP_URLS = required('LP_URL').split(',').map(url => url.trim());
const BANNER_URLS = required('BANNER_URL').split(',').map(url => url.trim());

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
  await mkdir(OUT_DIR, { recursive: true });
  await mkdir(TMP_DIR, { recursive: true });

  console.log(`LPs:`, LP_URLS);
  console.log(`Banners:`, BANNER_URLS);

  // 全バナーのハッシュを事前に計算（LPが変わっても共通なので1回だけでOK）
  const banners = [];
  for (let i = 0; i < BANNER_URLS.length; i++) {
    const url = BANNER_URLS[i];
    const bannerPath = path.join(OUT_DIR, `banner_input_${i}.png`);
    await downloadToFile(url, bannerPath);
    const bannerHash = await imghash.hash(bannerPath, 8, 'hex');
    banners.push({ id: i, url, hash: bannerHash });
  }

  const browser = await chromium.launch();
  const viewports = [
    { name: 'PC', context: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 } },
    { name: 'SP', context: devices['iPhone 13'] },
  ];

  // 全LPの結果を蓄積する配列
  const allResults = [];
  let totalAllFound = true;

  // ⭐ LP URLのループを追加
  for (let lpIdx = 0; lpIdx < LP_URLS.length; lpIdx++) {
    const lpUrl = LP_URLS[lpIdx];
    console.log(`\n=========================================`);
    console.log(`Processing LP [${lpIdx + 1}/${LP_URLS.length}]: ${lpUrl}`);
    console.log(`=========================================`);

    const results = { PC: {}, SP: {} };
    const screenshots = { PC: {}, SP: {} };

    for (const v of viewports) {
      console.log(`--- ${v.name} ---`);
      const ctx = await browser.newContext(v.context);
      const page = await ctx.newPage();

      try {
        await page.goto(lpUrl, { waitUntil: 'load', timeout: 120000 });

        await page.addStyleTag({ content: '[class*="modal"], [class*="popup"], [class*="overlay"], [class*="dialog"] { display: none !important; }' }).catch(() => {});
        await page.locator('text=閉じる').first().click({ timeout: 2000 }).catch(() => {});
        await page.locator('text=×').first().click({ timeout: 2000 }).catch(() => {});

        await autoScroll(page);
        await page.waitForLoadState('networkidle').catch(() => {});

        // ファイル名にLPのインデックスを含めてバッティングを防ぐ
        const screenshotPath = path.join(OUT_DIR, `lp_${lpIdx}_${v.name}.jpg`);
        await page.screenshot({ path: screenshotPath, fullPage: true, type: 'jpeg', quality: 85 });

        let screenshotUrl = null;
        if (S3_ENABLED) {
          const ts = new Date().toISOString().replace(/[:.]/g, '-');
          const key = `${S3_PREFIX}${ts}_lp${lpIdx}_${v.name}.jpg`;
          screenshotUrl = await uploadToS3(screenshotPath, key);
        }
        screenshots[v.name] = { path: screenshotPath, url: screenshotUrl };

        const imageSrcs = await page.evaluate(() => Array.from(document.querySelectorAll('img'))
          .filter((img) => img.complete && img.naturalWidth > 0)
          .map((img) => img.currentSrc || img.src)
          .filter((src) => src && !src.startsWith('data:'))
        );
        const uniqueSrcs = [...new Set(imageSrcs)];

        const bannerMatches = banners.map(b => ({ id: b.id, bestDist: Infinity, bestSrc: null }));

        for (const src of uniqueSrcs) {
          try {
            const h = await hashUrl(src);
            for (const b of bannerMatches) {
              const targetBanner = banners.find(x => x.id === b.id);
              const d = hammingHex(targetBanner.hash, h);
              if (d < b.bestDist) {
                b.bestDist = d;
                b.bestSrc = src;
              }
            }
          } catch (e) {
            console.warn(`hash failed for ${src.slice(0, 80)}: ${e.message}`);
          }
        }

        for (const b of bannerMatches) {
          results[v.name][b.id] = {
            found: b.bestDist <= THRESHOLD,
            distance: b.bestDist,
            bestSrc: b.bestSrc,
          };
        }
      } catch (err) {
        console.error(`Failed to process LP ${lpUrl}:`, err);
        for (const b of banners) {
          results[v.name][b.id] = { found: false, distance: Infinity, bestSrc: null };
        }
        screenshots[v.name] = { path: null, url: null };
      } finally {
        await ctx.close();
      }
    }

    allResults.push({ lpUrl, lpIdx, results, screenshots });
  }
  await browser.close();

  // ⭐ 通知用テキストの組み立て（全LP分を網羅）
  const detailLines = [];
  allResults.forEach(item => {
    detailLines.push(`\n🌐 *LP*: ${item.lpUrl}`);
    banners.forEach(b => {
      const pcRes = item.results.PC[b.id];
      const spRes = item.results.SP[b.id];
      if (!pcRes.found || !spRes.found) totalAllFound = false;

      detailLines.push(`  【バナー ${b.id + 1}】: ${b.url}`);
      detailLines.push(`    *PC*: ${pcRes.found ? '✅ 検出' : '❌ 未検出'} (距離 ${pcRes.distance})`);
      detailLines.push(`    *SP*: ${spRes.found ? '✅ 検出' : '❌ 未検出'} (距離 ${spRes.distance})`);
    });
  });

  const headline = totalAllFound ? '✅ すべてのLPで、すべてのバナーが問題なくアップされています' : '⚠️ 一部またはすべてのLP・バナーに問題があります';
  const detail = [...detailLines, `\n閾値: ${THRESHOLD}`].join('\n');

  console.log('====== 総合判定結果 ======');
  console.log(headline);
  console.log(detail);
  console.log('==========================');

  // ⭐ Yoom への通知（LPごとの配列構造にペイロードを変更）
  if (YOOM_WEBHOOK_URL) {
    const yoomLps = [];
    for (const item of allResults) {
      const yoomBanners = [];
      for (const b of banners) {
        const buildViewportPayload = async (name) => {
          const r = item.results[name][b.id];
          const s = item.screenshots[name];
          if (!s.path) return { found: false, distance: Infinity };
          if (S3_ENABLED && s.url) return { found: r.found, distance: r.distance, image_url: s.url };
          return {
            found: r.found,
            distance: r.distance,
            image_b64: (await readFile(s.path)).toString('base64'),
            image_filename: path.basename(s.path),
            image_mime: 'image/jpeg',
          };
        };

        yoomBanners.push({
          url: b.url,
          pc: await buildViewportPayload('PC'),
          sp: await buildViewportPayload('SP'),
        });
      }
      yoomLps.push({ lp_url: item.lpUrl, banners: yoomBanners });
    }

    const payload = { headline, all_found: totalAllFound, threshold: THRESHOLD, lps: yoomLps };
    const resp = await fetch(YOOM_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) console.error(`Yoom webhook failed: HTTP ${resp.status}`);
  }

  // ⭐ Slack への通知（1つの投稿に対し、各LPのスクショをスレッドでぶら下げる）
  if (SLACK_BOT_TOKEN && SLACK_CHANNEL) {
    const slack = new WebClient(SLACK_BOT_TOKEN);
    const post = await slack.chat.postMessage({
      channel: SLACK_CHANNEL,
      text: `${headline}\n${detail}`,
    });

    for (const item of allResults) {
      for (const v of viewports) {
        const s = item.screenshots[v.name];
        if (s.path) {
          await slack.files.uploadV2({
            channel_id: SLACK_CHANNEL,
            thread_ts: post.ts,
            file: s.path,
            filename: `lp_${item.lpIdx}_${v.name}.png`,
            initial_comment: `LP [${item.lpIdx + 1}] ${v.name} スクリーンショット`,
          });
        }
      }
    }
  }

  if (!totalAllFound) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
