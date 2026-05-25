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

const LP_URL = required('LP_URL');
const BANNER_URL = required('BANNER_URL');
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

const s3Client = S3_ENABLED
  ? new S3Client({
      region: AWS_REGION,
      credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY },
    })
  : null;

async function uploadToS3(filepath, key) {
  const buf = await readFile(filepath);
  await s3Client.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Body: buf,
      ContentType: 'image/jpeg',
    })
  );
  return `https://${S3_BUCKET}.s3.${AWS_REGION}.amazonaws.com/${key}`;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  await mkdir(TMP_DIR, { recursive: true });

  console.log(`LP: ${LP_URL}`);
  console.log(`Banner: ${BANNER_URL}`);

  const bannerPath = path.join(OUT_DIR, 'banner_input.png');
  await downloadToFile(BANNER_URL, bannerPath);
  const bannerHash = await imghash.hash(bannerPath, 8, 'hex');
  console.log(`Banner hash: ${bannerHash}`);

  const browser = await chromium.launch();
  const viewports = [
    { name: 'PC', context: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 } },
    { name: 'SP', context: devices['iPhone 13'] },
  ];

  const results = {};

  for (const v of viewports) {
    console.log(`--- ${v.name} ---`);
    const ctx = await browser.newContext(v.context);
    const page = await ctx.newPage();
    await page.goto(LP_URL, { waitUntil: 'load', timeout: 120000 });
// 👇 【ここから追加】ポップアップを強制非表示 ＆ 閉じる処理
    await page.addStyleTag({ content: '[class*="modal"], [class*="popup"], [class*="overlay"], [class*="dialog"] { display: none !important; }' }).catch(() => {});
    await page.locator('text=閉じる').first().click({ timeout: 2000 }).catch(() => {});
    await page.locator('text=×').first().click({ timeout: 2000 }).catch(() => {});
// 👆 【ここまで追加】
    await autoScroll(page);
    await page.waitForLoadState('networkidle').catch(() => {});

    const screenshotPath = path.join(OUT_DIR, `${v.name}.jpg`);
    await page.screenshot({ path: screenshotPath, fullPage: true, type: 'jpeg', quality: 85 });

    let screenshotUrl = null;
    if (S3_ENABLED) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const key = `${S3_PREFIX}${ts}_${v.name}.jpg`;
      screenshotUrl = await uploadToS3(screenshotPath, key);
      console.log(`Uploaded ${v.name} to S3: ${screenshotUrl}`);
    }

    const imageSrcs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('img'))
        .filter((img) => img.complete && img.naturalWidth > 0)
        .map((img) => img.currentSrc || img.src)
        .filter((src) => src && !src.startsWith('data:'))
    );

    const uniqueSrcs = [...new Set(imageSrcs)];
    console.log(`Found ${uniqueSrcs.length} loaded images`);

    let bestDist = Infinity;
    let bestSrc = null;
    for (const src of uniqueSrcs) {
      try {
        const h = await hashUrl(src);
        const d = hammingHex(bannerHash, h);
        if (d < bestDist) {
          bestDist = d;
          bestSrc = src;
        }
      } catch (e) {
        console.warn(`hash failed for ${src.slice(0, 80)}: ${e.message}`);
      }
    }

    results[v.name] = {
      found: bestDist <= THRESHOLD,
      distance: bestDist,
      bestSrc,
      screenshotPath,
      screenshotUrl,
    };
    console.log(`${v.name} best distance: ${bestDist} (threshold ${THRESHOLD}) -> ${results[v.name].found ? 'FOUND' : 'NOT FOUND'}`);
    await ctx.close();
  }

  await browser.close();

  const allFound = results.PC.found && results.SP.found;
  const headline = allFound ? '✅ 問題なくアップされています' : '⚠️ 問題があります';
  const detail = [
    `*PC*: ${results.PC.found ? '✅ 検出' : '❌ 未検出'} (距離 ${results.PC.distance})`,
    `*SP*: ${results.SP.found ? '✅ 検出' : '❌ 未検出'} (距離 ${results.SP.distance})`,
    `LP: ${LP_URL}`,
    `閾値: ${THRESHOLD}（小さいほど類似）`,
  ].join('\n');

  console.log('====== 判定結果 ======');
  console.log(headline);
  console.log(detail);
  console.log('======================');

  if (YOOM_WEBHOOK_URL) {
    const buildViewportPayload = async (r) => {
      if (S3_ENABLED && r.screenshotUrl) {
        return {
          found: r.found,
          distance: r.distance,
          image_url: r.screenshotUrl,
        };
      }
      return {
        found: r.found,
        distance: r.distance,
        image_b64: (await readFile(r.screenshotPath)).toString('base64'),
        image_filename: path.basename(r.screenshotPath),
        image_mime: 'image/jpeg',
      };
    };

    const payload = {
      headline,
      all_found: allFound,
      lp_url: LP_URL,
      threshold: THRESHOLD,
      pc: await buildViewportPayload(results.PC),
      sp: await buildViewportPayload(results.SP),
    };
    const payloadSize = Buffer.byteLength(JSON.stringify(payload));
    console.log(`Yoom payload size: ${(payloadSize / 1024 / 1024).toFixed(2)} MB`);

    const resp = await fetch(YOOM_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      console.error(`Yoom webhook failed: HTTP ${resp.status} ${await resp.text()}`);
    } else {
      console.log(`Yoom webhook posted (HTTP ${resp.status}).`);
    }
  } else {
    console.log('YOOM_WEBHOOK_URL not set. Skipping Yoom callback.');
  }

  if (SLACK_BOT_TOKEN && SLACK_CHANNEL) {
    const slack = new WebClient(SLACK_BOT_TOKEN);
    const post = await slack.chat.postMessage({
      channel: SLACK_CHANNEL,
      text: `${headline}\n${detail}`,
    });
    for (const v of viewports) {
      await slack.files.uploadV2({
        channel_id: SLACK_CHANNEL,
        thread_ts: post.ts,
        file: results[v.name].screenshotPath,
        filename: `${v.name}.png`,
        initial_comment: `${v.name} スクリーンショット`,
      });
    }
    console.log('Slack post done.');
  } else {
    console.log('Slack credentials not set. Skipping Slack post (screenshots are uploaded as workflow artifacts).');
  }

  if (!allFound) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
