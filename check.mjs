import { chromium, devices } from 'playwright';
import imghash from 'imghash';
import { WebClient } from '@slack/web-api';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

function required(name) {
  const v = process.env[name]; 
  if ( ! v ) {
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
  if ( ! url.startsWith('http') ) {
    const buf = await readFile(url); 
    await writeFile(filepath, buf); 
    return; 
  } 
  const resp = await fetch(url); 
  if ( ! resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`); 
  const buf = Buffer.from(await resp.arrayBuffer()); 
  await writeFile(filepath, buf); 
} 

async function hashUrl(url) {
  const tmpPath = path.join(TMP_DIR, `${randomUUID()}.bin`); 
  try {
    await downloadToFile(url, tmpPath); 
    return await imghash.hash(tmpPath, 8, 'hex'); 
  } catch (e) {
    throw new Error(`Download or Hash failed: ${e.message}`); 
  } finally {
    await rm(tmpPath, {force: true}); 
  } 
} 

const s3Client = S3_ENABLED ? new S3Client({
  region: AWS_REGION, 
  credentials: {accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY}, 
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
  await mkdir(OUT_DIR, {recursive: true}); 
  await mkdir(TMP_DIR, {recursive: true}); 
  await mkdir('banners', {recursive: true}).catch(() => {}); 

  // 💡 { recursive: true } を追加し、サブフォルダの中身もすべて再帰的に自動取得します
  const files = await readdir('banners', { recursive: true }); 
  const imageExtensions = ['.png', '.jpg', '.jpeg', '.webp', '.gif']; 
  const bannerFiles = files.filter(f => imageExtensions.includes(path.extname(f).toLowerCase())); 

  console.log("========================================="); 
  console.log(`🚀 ターゲットLP:`, LP_URLS); 
  console.log(`🚀 検出したGitHub上のバナー数: ${bannerFiles.length}件`); 
  console.log("====== [DEBUG] Slack 環境変数確認 ======"); 
  console.log("SLACK_BOT_TOKENが存在するか:", SLACK_BOT_TOKEN ? "✅ YES" : "❌ NO (空っぽ)"); 
  console.log("SLACK_CHANNELが存在するか:", SLACK_CHANNEL ? `✅ YES (${SLACK_CHANNEL})` : "❌ NO (空っぽ)"); 
  console.log("PARENT_THREAD_TSの値:", process.env.PARENT_THREAD_TS ? `「${process.env.PARENT_THREAD_TS}」` : "❌ 空っぽ"); 
  console.log("========================================="); 

  const banners = [ ] ; 
  for (let i = 0; i < bannerFiles.length; i++) {
    const filename = bannerFiles[i]; 
    const bannerPath = path.join('banners', filename); 
    const bannerHash = await imghash.hash(bannerPath, 8, 'hex'); 
    // Slackなどの表示にフォルダ名が含まれるようにfilename（相対パス）をそのまま入れます
    banners.push({id: i, url: filename, hash: bannerHash}); 
  } 

  const browser = await chromium.launch({
    args: ['--disable-web-security', '--disable-features=IsolateOrigins,site-per-process']
  }); 
  const viewports = [
    {name: 'PC', context: {viewport: {width: 1280, height: 800}, deviceScaleFactor: 1}}, 
    {name: 'SP', context: devices['iPhone 13']}, 
  ]; 
  const allResults = [ ] ; 
  let totalAllFound = true; 

  for (let lpIdx = 0; lpIdx < LP_URLS.length; lpIdx++) {
    const lpUrl = LP_URLS[lpIdx]; 
    console.log(`Processing LP [${lpIdx + 1}/${LP_URLS.length}]: ${lpUrl}`); 
    const results = {PC: {}, SP: {}}; 
    const screenshots = {PC: {}, SP: {}}; 

    for (const v of viewports) {
      const ctx = await browser.newContext(v.context); 
      const page = await ctx.newPage(); 
      try {
        await page.goto(lpUrl, {waitUntil: 'load', timeout: 120000}); 
        await page.addStyleTag({content: '[class*="modal"], [class*="popup"], [class*="overlay"], [class*="dialog"] { display: none !important; }'}).catch(() => {}); 
        await page.locator('text=閉じる').first().click({timeout: 2000}).catch(() => {}); 
        await page.locator('text=×').first().click({timeout: 2000}).catch(() => {}); 
        await autoScroll(page); 
        await page.waitForLoadState('networkidle').catch(() => {}); 
        await page.evaluate(() => document.fonts.ready).catch(() => {}); 
        await page.waitForTimeout(2000); 
        const screenshotPath = path.join(OUT_DIR, `lp_${lpIdx}_${v.name}.jpg`); 
        await page.screenshot({path: screenshotPath, fullPage: true, type: 'jpeg', quality: 85}); 
        let screenshotUrl = null; 
        if (S3_ENABLED) {
          const ts = new Date().toISOString().replace(/[:.]/g, '-'); 
          const key = `${S3_PREFIX}${ts}_lp${lpIdx}_${v.name}.jpg`; 
          screenshotUrl = await uploadToS3(screenshotPath, key); 
        } 
        screenshots[v.name] = {path: screenshotPath, url: screenshotUrl}; 
        const imageSrcs = [ ] ; 
        for (const frame of page.frames()) {
          try {
            const srcs = await frame.evaluate(() => Array.from(document.querySelectorAll('img'))
              .filter((img) => img.complete && img.naturalWidth > 0)
              .map((img) => img.currentSrc || img.src)
              .filter((src) => src && ! src.startsWith('data:'))
            ); 
            imageSrcs.push(...srcs); 
          } catch (e) {} 
        } 
        const uniqueSrcs = [...new Set(imageSrcs)]; 
        const bannerMatches = banners.map(b => ({id: b.id, bestDist: Infinity, bestSrc: null})); 
        const hashResults = await Promise.all(uniqueSrcs.map(async (src) => {
          try {
            const h = await hashUrl(src); 
            return {src, h}; 
          } catch (e) {
            return null; 
          } 
        })); 
        for (const res of hashResults) {
          if ( ! res) continue; 
          for (const b of bannerMatches) {
            const targetBanner = banners.find(x => x.id === b.id); 
            const d = hammingHex(targetBanner.hash, res.h); 
            if (d < b.bestDist) {
              b.bestDist = d; 
              b.bestSrc = res.src; 
            } 
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
          results[v.name][b.id] = {found: false, distance: Infinity, bestSrc: null}; 
        } 
        screenshots[v.name] = {path: null, url: null}; 
      } finally {
        await ctx.close(); 
      } 
    } 
    allResults.push({lpUrl, lpIdx, results, screenshots}); 
  } 
  await browser.close(); 

  const detailLines = [ ] ; 
  allResults.forEach(item => {
    detailLines.push(`\n🌐 *LP*: ${item.lpUrl}`); 
    banners.forEach(b => {
      const pcRes = item.results.PC[b.id]; 
      const spRes = item.results.SP[b.id]; 
      if ( ! pcRes.found || ! spRes.found) totalAllFound = false; 
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

  if (YOOM_WEBHOOK_URL) {
    const yoomLps = [ ] ; 
    for (const item of allResults) {
      const yoomBanners = [ ] ; 
      for (const b of banners) {
        const buildViewportPayload = async (name) => {
          const r = item.results[name][b.id]; 
          const s = item.screenshots[name]; 
          if ( ! s.path) return {found: false, distance: Infinity}; 
          if (S3_ENABLED && s.url) return {found: r.found, distance: r.distance, image_url: s.url}; 
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
      yoomLps.push({lp_url: item.lpUrl, banners: yoomBanners}); 
    } 
    const payload = {headline, all_found: totalAllFound, threshold: THRESHOLD, lps: yoomLps}; 
    const resp = await fetch(YOOM_WEBHOOK_URL, {
      method: 'POST', 
      headers: {'Content-Type': 'application/json'}, 
      body: JSON.stringify(payload), 
    }); 
    if ( ! resp.ok) console.error(`Yoom webhook failed: HTTP ${resp.status}`); 
  } 

  if (SLACK_BOT_TOKEN && SLACK_CHANNEL) {
    console.log("📬 Slackへの送信処理を開始します..."); 
    try {
      const slack = new WebClient(SLACK_BOT_TOKEN); 
      let rawThreadTs = (process.env.PARENT_THREAD_TS || '').trim(); 
      let threadTs = (rawThreadTs && ! rawThreadTs.includes('${{') && ! isNaN(parseFloat(rawThreadTs))) ? rawThreadTs : undefined; 
      if ( ! threadTs && rawThreadTs) {
        console.log(`⚠️ スレッドID「${rawThreadTs}」の形式が不正なため、新規メッセージとして投稿します。`); 
      } 
      await slack.chat.postMessage({
        channel: SLACK_CHANNEL, 
        ...(threadTs ? {thread_ts: threadTs} : {}), 
        text: `${headline}\n${detail}`, 
      }); 
      console.log("✅ Slackへ結果テキストを送信しました。"); 
      for (const item of allResults) {
        for (const v of viewports) {
          const s = item.screenshots[v.name]; 
          if (s.path) {
            await slack.files.uploadV2({
              channel_id: SLACK_CHANNEL, 
              ...(threadTs ? {thread_ts: threadTs} : {}), 
              file_uploads: [{file: s.path, filename: path.basename(s.path)}]
            }).catch(e => console.error(`⚠️ 画像アップロード失敗 (${s.path}):`, e.message)); 
          } 
        } 
      } 
    } catch (slackError) {
      console.error("❌ Slackへのメイン送信ブロックでエラーが発生しました:", slackError.message); 
    } 
  } else {
    console.log("⚠️ SLACK_BOT_TOKEN または SLACK_CHANNEL が未設定のためSlack送信をスキップしました。"); 
  } 
  if ( ! totalAllFound) {
    console.log("⚠️ 検出できなかったバナーがあるため、意図的に exit code 1 で終了します。"); 
    process.exit(1); 
  } 
} 

main().catch(async (err) => {
  console.error("🔥 main()内部で予期せぬエラーが発生しました:", err); 
  const token = process.env.SLACK_BOT_TOKEN; 
  const channel = process.env.SLACK_CHANNEL; 
  let rawThreadTs = (process.env.PARENT_THREAD_TS || '').trim(); 
  let threadTs = (rawThreadTs && ! rawThreadTs.includes('${{') && ! isNaN(parseFloat(rawThreadTs))) ? rawThreadTs : undefined; 
  const lpUrl = process.env.LP_URL || "不明なURL"; 
  if (token && channel) {
    try {
      const { WebClient } = await import('@slack/web-api'); 
      const client = new WebClient(token); 
      await client.chat.postMessage({
        channel: channel, 
        ...(threadTs ? {thread_ts: threadTs} : {}), 
        text: `❌ *スクリプトが途中で強制中断されました* (${lpUrl})\n*原因*: ${err.message || err}`
      }); 
      console.log("✅ Slackへエラー中断通知を送信しました。"); 
    } catch (slackErr) {
      console.error('❌ エラー通知の送信にも失敗しました:', slackErr.message); 
    } 
  } 
  process.exit(1); 
});
