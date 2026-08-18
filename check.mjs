import { chromium, devices } from 'playwright';
import imghash from 'imghash';
import { imageSize } from 'image-size';
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
let LP_URLS = [ ];

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

// 📏 バナーサイズ（px）→ 掲載デバイスの対応表
// ファイル名の PC/SP 表記に頼らず、画像の実サイズで判定する。
const SIZE_DEVICE_MAP = {
  '728x90': 'PC',
  '160x600': 'PC',
  '300x600': 'PC',
  '320x100': 'SP',
  '300x250': 'SP',
};

function classifyDevice(width, height) {
  return SIZE_DEVICE_MAP[`${width}x${height}`] || 'UNKNOWN';
}

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
      const step = 300;
      const timer = setInterval(() => {
        window.scrollBy(0, step);
        total += step;
        if (total >= document.body.scrollHeight + 1000) {
          clearInterval(timer);
          resolve(undefined);
        }
      }, 50);
    });
  });
  await page.waitForTimeout(800);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
}

// モーダル・ポップアップ等を隠す。
// class名だけで判定すると本文コンテンツを誤って隠す恐れがあるため、
// 「fixed/sticky配置」かつ「該当クラス名を含む」要素のみを対象にする。
async function hideOverlays(page) {
  await page.evaluate(() => {
    const pattern = /modal|popup|overlay|dialog/i;
    document.querySelectorAll('body *').forEach((el) => {
      if (typeof el.className !== 'string' || ! pattern.test(el.className)) return;
      const style = getComputedStyle(el);
      if (style.position === 'fixed' || style.position === 'sticky') {
        el.style.setProperty('display', 'none', 'important');
      }
    });
  }).catch(() => {});
}

// モーダルの閉じるボタンを押す。
// 「閉じる」「×」というテキストは、バナー自体やその親要素が <a href> で
// 覆われているケースがあり、無条件にクリックすると本来のLPから離脱して
// バナーのリンク先（掲載先LP）に遷移してしまい、以降のスクショが
// 意図したLPではなく掲載先LPのものになってしまう。
// そのためリンク（またはリンクの子孫）の要素はクリック対象から除外する。
async function clickCloseIfSafe(page, text) {
  const candidates = page.locator(`text=${text}`);
  const count = await candidates.count().catch(() => 0);
  for (let i = 0; i < count; i++) {
    const el = candidates.nth(i);
    const isLink = await el.evaluate((node) => !!node.closest('a[href]')).catch(() => true);
    if (isLink) continue;
    const clicked = await el.click({timeout: 2000}).then(() => true).catch(() => false);
    if (clicked) return;
  }
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

// ページ内の画像を収集する。<img> タグに加えて、CSSの background-image も対象にする。
// バナーのクリック先（<a href>）も一緒に取得し、後で「掲載先LP」のキャプチャに使う。
async function collectImageSrcs(page) {
  const items = [ ];
  for (const frame of page.frames()) {
    try {
      const results = await frame.evaluate(() => {
        const closestHref = (el) => {
          const a = el.closest ? el.closest('a[href]') : null;
          return a ? a.href : null;
        };

        const imgItems = Array.from(document.querySelectorAll('img'))
          .filter((img) => img.complete && img.naturalWidth > 0)
          .map((img) => ({src: img.currentSrc || img.src, href: closestHref(img)}));

        const bgItems = Array.from(document.querySelectorAll('*'))
          .map((el) => {
            const bg = getComputedStyle(el).backgroundImage;
            const m = bg && bg.match(/url\(["']?(.*?)["']?\)/);
            return m ? {src: m[1], href: closestHref(el)} : null;
          })
          .filter(Boolean);

        return [...imgItems, ...bgItems].filter((it) => it.src && ! it.src.startsWith('data:'));
      });
      items.push(...results);
    } catch (e) {}
  }

  // src単位で重複排除しつつ、hrefが取れているものを優先する
  const bySrc = new Map();
  for (const it of items) {
    if ( ! bySrc.has(it.src) || ( ! bySrc.get(it.src).href && it.href)) {
      bySrc.set(it.src, it);
    }
  }
  return [...bySrc.values()];
}

// 任意のURLをPC/SP指定のビューポートでフルページキャプチャする（バナー掲載先LPのキャプチャに使用）。
async function captureScreenshot(browser, viewportConfig, url, screenshotPath) {
  const ctx = await browser.newContext(viewportConfig);
  const page = await ctx.newPage();
  try {
    await page.goto(url, {waitUntil: 'domcontentloaded', timeout: 150000});
    await hideOverlays(page);
    await clickCloseIfSafe(page, '閉じる');
    await clickCloseIfSafe(page, '×');
    await autoScroll(page);
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.evaluate(() => document.fonts.ready).catch(() => {});
    await page.waitForTimeout(1000);
    await page.screenshot({path: screenshotPath, fullPage: true, type: 'jpeg', quality: 70});
    let screenshotUrl = null;
    if (S3_ENABLED) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const key = `${S3_PREFIX}${ts}_${path.basename(screenshotPath, '.jpg')}.jpg`;
      screenshotUrl = await uploadToS3(screenshotPath, key);
    }
    return {path: screenshotPath, url: screenshotUrl, error: null};
  } catch (err) {
    return {path: null, url: null, error: err};
  } finally {
    await ctx.close();
  }
}

// サイズ(px)ごとにバナーをグルーピングする。
// 例：728x90が2種類ある場合、1つのスロットに対して同時に表示されるのはどちらか1つだけのはず。
// なので「サイズ」を1スロットとみなし、そのスロットで最もハッシュ距離が近い(=一致度が高い)
// バナーだけを「実際に掲載されている1つ」として確定させる。
function groupBannersBySize(banners) {
  const groups = new Map();
  for (const b of banners) {
    const key = `${b.width}x${b.height}`;
    if ( ! groups.has(key)) {
      groups.set(key, {sizeKey: key, device: b.device, members: [ ]});
    }
    groups.get(key).members.push(b);
  }
  return [...groups.values()];
}

// あるビューポート(PC/SP)の結果の中から、各サイズグループにつき「最有力の1つ」を選ぶ
function pickWinnersForViewport(groups, viewportResults, deviceName) {
  const winners = [ ];
  for (const g of groups) {
    // このビューポートに関係ないグループはスキップ（PC専用サイズはSP側では見ない、等）
    if (g.device !== 'UNKNOWN' && g.device !== deviceName) continue;

    let best = null;
    for (const b of g.members) {
      const r = viewportResults[b.id];
      if ( ! r || ! r.found) continue;
      if ( ! best || r.distance < best.distance) {
        best = {banner: b, distance: r.distance, bestSrc: r.bestSrc, bestHref: r.bestHref};
      }
    }
    winners.push({sizeKey: g.sizeKey, device: g.device, winner: best});
  }
  return winners;
}

async function main() {
  const rawLpUrl = required('LP_URL');
  LP_URLS = rawLpUrl.split(',').map(url => url.trim()).filter(Boolean);
  await mkdir(OUT_DIR, {recursive: true});
  await mkdir(TMP_DIR, {recursive: true});
  await mkdir('banners', {recursive: true}).catch(() => {});

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

  // バナーごとに実サイズを読み取り、PC/SPを判定する（ファイル名は判定に使わない）
  const banners = [ ];
  for (let i = 0; i < bannerFiles.length; i++) {
    const filename = bannerFiles[i];
    const bannerPath = path.join('banners', filename);
    const buf = await readFile(bannerPath);

    let width = null, height = null, device = 'UNKNOWN';
    try {
      const dim = imageSize(buf);
      width = dim.width;
      height = dim.height;
      device = classifyDevice(width, height);
    } catch (e) {
      console.log(`⚠️ 【${filename}】のサイズ取得に失敗しました: ${e.message}`);
    }

    if (device === 'UNKNOWN') {
      console.log(`⚠️ 【${filename}】(${width}x${height}) は既知のバナーサイズ一覧に一致しません。PC/SP両方を照合対象にします。`);
    } else {
      console.log(`🏷️ 【${filename}】(${width}x${height}) → ${device} 用バナーと判定`);
    }

    const bannerHash = await imghash.hash(bannerPath, 8, 'hex');
    banners.push({id: i, url: filename, hash: bannerHash, width, height, device});
  }

  const bannerGroups = groupBannersBySize(banners);
  console.log(`🗂️ サイズ別スロット数: ${bannerGroups.length}件（同一サイズに複数バナーがある場合は最有力の1つを採用します）`);

  const browser = await chromium.launch({
    args: ['--disable-features=IsolateOrigins,site-per-process']
  });
  const viewports = [
    {name: 'PC', context: {viewport: {width: 1280, height: 800}, deviceScaleFactor: 1}},
    {name: 'SP', context: devices['iPhone 13']},
  ];
  const allResults = [ ];
  let hasTechnicalError = false;
  // 🔗 バナーのリンク先（クリック後のLP）は、どのLPで検出しても同じURL（枝分かれのみ）になるため、
  // LPごとに何度もキャプチャせず、実行全体で1回だけ（重複排除して）キャプチャする。
  const globalDestHrefs = new Set();

  for (let lpIdx = 0; lpIdx < LP_URLS.length; lpIdx++) {
    const lpUrl = LP_URLS[lpIdx];
    console.log(`Processing LP [${lpIdx + 1}/${LP_URLS.length}]: ${lpUrl}`);

    let results = {PC: {}, SP: {}};
    let screenshots = {PC: {}, SP: {}};
    let navError = {PC: false, SP: false};

    // 💡 リトライ制御用（最大2回スキャンを試みます）
    // 「特定のバナーが1つでも欠けている」ことをリトライ条件にすると、
    // トリガー次第で正常に非表示のバナーがあるたびに毎回リトライしてしまい時間がかかるため、
    // 「そのページで“1件もバナーが検出できなかった”＝読み込みタイミングの問題の可能性が高い」場合のみ再試行する。
    const MAX_RETRIES = 2;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 1) {
        console.log(`\n⚠️ バナーが1件も検出できなかったため、再スキャンを実行します（試行 ${attempt}/${MAX_RETRIES}）`);
        await new Promise(resolve => setTimeout(resolve, 3000));
      }

      results = {PC: {}, SP: {}};
      screenshots = {PC: {}, SP: {}};
      navError = {PC: false, SP: false};

      // 🚀 PC/SPのキャプチャは互いに独立しているため並列実行して時間を短縮する
      await Promise.all(viewports.map(async (v) => {
        const ctx = await browser.newContext(v.context);
        const page = await ctx.newPage();
        try {
          // 'load' は広告タグ等の外部リソース全ての完了を待つため、
          // 1つでも遅延・ハングするとタイムアウトしやすい。
          // 'domcontentloaded' + 後続のスクロール/networkidle待ちで十分描画は待てるため、こちらに変更。
          await page.goto(lpUrl, {waitUntil: 'domcontentloaded', timeout: 150000});
          await hideOverlays(page);
          await clickCloseIfSafe(page, '閉じる');
          await clickCloseIfSafe(page, '×');
          await autoScroll(page);
          await page.waitForLoadState('networkidle').catch(() => {});
          await page.evaluate(() => document.fonts.ready).catch(() => {});
          await page.waitForTimeout(1000);
          const screenshotPath = path.join(OUT_DIR, `lp_${lpIdx}_${v.name}.jpg`);
          // 📉 キャプチャを軽量化（画質85→70。判定への影響は軽微、Slackアップロードも高速化）
          await page.screenshot({path: screenshotPath, fullPage: true, type: 'jpeg', quality: 70});
          let screenshotUrl = null;
          if (S3_ENABLED) {
            const ts = new Date().toISOString().replace(/[:.]/g, '-');
            const key = `${S3_PREFIX}${ts}_lp${lpIdx}_${v.name}.jpg`;
            screenshotUrl = await uploadToS3(screenshotPath, key);
          }
          screenshots[v.name] = {path: screenshotPath, url: screenshotUrl};

          const uniqueImages = await collectImageSrcs(page);
          const bannerMatches = banners.map(b => ({id: b.id, bestDist: Infinity, bestSrc: null, bestHref: null}));
          const hashResults = await Promise.all(uniqueImages.map(async ({src, href}) => {
            try {
              const h = await hashUrl(src);
              return {src, href, h};
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
                b.bestHref = res.href;
              }
            }
          }
          for (const b of bannerMatches) {
            results[v.name][b.id] = {
              found: b.bestDist <= THRESHOLD,
              distance: b.bestDist,
              bestSrc: b.bestSrc,
              bestHref: b.bestHref,
            };
          }
        } catch (err) {
          console.error(`Failed to process LP ${lpUrl} (${v.name}):`, err);
          navError[v.name] = true;
          for (const b of banners) {
            results[v.name][b.id] = {found: false, distance: Infinity, bestSrc: null, bestHref: null};
          }
          screenshots[v.name] = {path: null, url: null};
        } finally {
          await ctx.close();
        }
      }));

      // 💡 再スキャン判定：PC・SP合わせて1件も検出できなかった場合のみ再試行する
      const totalFound = banners.filter(b => results.PC[b.id]?.found || results.SP[b.id]?.found).length;
      const shouldRetry = totalFound === 0 && ! navError.PC && ! navError.SP;

      if ( ! shouldRetry) {
        break;
      }

      if (attempt < MAX_RETRIES) {
        console.log(`❌ 試行 ${attempt}: バナーが1件も検出できなかったため、ページを読み直して再スキャンします。`);
      } else {
        console.log(`❌ 最大リトライ回数（${MAX_RETRIES}回）に達しました。以降は検出結果をそのまま報告します。`);
      }
    }

    if (navError.PC || navError.SP) hasTechnicalError = true;

    // サイズグループごとに「実際に掲載されている1つ」を確定する
    const winnersPC = pickWinnersForViewport(bannerGroups, results.PC, 'PC');
    const winnersSP = pickWinnersForViewport(bannerGroups, results.SP, 'SP');

    // 掲載が確認できたバナーのリンク先（クリック後のLP）を記録する（キャプチャは全体で1回だけ後段でまとめて行う）
    for (const w of [...winnersPC, ...winnersSP]) {
      if (w.winner && w.winner.bestHref && ! LP_URLS.includes(w.winner.bestHref)) {
        globalDestHrefs.add(w.winner.bestHref);
      }
    }

    allResults.push({lpUrl, lpIdx, results, screenshots, navError, winnersPC, winnersSP});
  }

  // 🔗 バナーのリンク先（クリック後のLP）を、PC/SPの2パターンで1回だけキャプチャする
  const destinationCaptures = [ ];
  let destIdx = 0;
  for (const href of globalDestHrefs) {
    const shots = {PC: {path: null, url: null}, SP: {path: null, url: null}};
    for (const v of viewports) {
      const screenshotPath = path.join(OUT_DIR, `dest_${destIdx}_${v.name}.jpg`);
      const res = await captureScreenshot(browser, v.context, href, screenshotPath);
      if (res.error) {
        console.error(`Failed to capture banner destination LP ${href} (${v.name}):`, res.error);
      }
      shots[v.name] = {path: res.path, url: res.url};
    }
    destinationCaptures.push({href, screenshots: shots});
    destIdx++;
  }

  await browser.close();

  // ====== レポート生成 ======
  // 注意：トリガーによって表示バナーが変わる仕様のため、「未検出」を一律で異常扱いにしない。
  // サイズ(スロット)ごとに「どのバナーが実際に掲載されているか」を報告する。
  const detailLines = [ ];
  allResults.forEach(item => {
    detailLines.push(`\n🌐 *LP*: ${item.lpUrl}`);

    if (item.navError.PC || item.navError.SP) {
      detailLines.push(`  🔥 *取得エラー*: ${item.navError.PC ? 'PC ' : ''}${item.navError.SP ? 'SP' : ''} の画面取得に失敗しました。`);
    }

    detailLines.push(`  🖥️ *PC掲載バナー*${item.navError.PC ? '（⚠️取得失敗のため未確認）' : ''}`);
    item.winnersPC.forEach(w => {
      const label = item.navError.PC
        ? '取得失敗のため未確認'
        : (w.winner ? `【${w.winner.banner.url}】(距離${w.winner.distance})` : '掲載なし');
      detailLines.push(`    ・${w.sizeKey}: ${label}`);
    });

    detailLines.push(`  📱 *SP掲載バナー*${item.navError.SP ? '（⚠️取得失敗のため未確認）' : ''}`);
    item.winnersSP.forEach(w => {
      const label = item.navError.SP
        ? '取得失敗のため未確認'
        : (w.winner ? `【${w.winner.banner.url}】(距離${w.winner.distance})` : '掲載なし');
      detailLines.push(`    ・${w.sizeKey}: ${label}`);
    });
  });

  if (destinationCaptures.length > 0) {
    detailLines.push(`\n🔗 *バナー掲載先LP（クリック後の遷移先・全LP共通のため1回だけ取得）*`);
    destinationCaptures.forEach(d => {
      const pcOk = d.screenshots.PC.path ? 'OK' : '取得失敗';
      const spOk = d.screenshots.SP.path ? 'OK' : '取得失敗';
      detailLines.push(`  ・${d.href} (PC: ${pcOk} / SP: ${spOk})`);
    });
  }

  const headline = hasTechnicalError
    ? '⚠️ 一部LPの画面取得でエラーが発生しました（下記詳細を確認してください）'
    : '📊 LPバナー掲載チェック結果（トリガーにより表示バナーは変動するため、掲載なし表記は必ずしも異常ではありません）';
  const detail = [...detailLines, `\n閾値: ${THRESHOLD}`].join('\n');

  console.log('====== 総合判定結果 ======');
  console.log(headline);
  console.log(detail);
  console.log('==========================');

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
      // 🚀 PC/SPの画像アップロードも並列化して時間を短縮する
      await Promise.all(allResults.flatMap(item => viewports.map(async (v) => {
        const s = item.screenshots[v.name];
        if ( ! s.path) return;
        await slack.files.uploadV2({
          channel_id: SLACK_CHANNEL,
          ...(threadTs ? {thread_ts: threadTs} : {}),
          file_uploads: [{file: s.path, filename: path.basename(s.path)}]
        }).catch(e => console.error(`⚠️ 画像アップロード失敗 (${s.path}):`, e.message));
      })));
      // 🔗 バナー掲載先LP（クリック後の遷移先）のPC/SPキャプチャもアップロードする（全LP共通のため1回分のみ）
      await Promise.all(destinationCaptures.flatMap(d => viewports.map(async (v) => {
        const s = d.screenshots[v.name];
        if ( ! s.path) return;
        await slack.files.uploadV2({
          channel_id: SLACK_CHANNEL,
          ...(threadTs ? {thread_ts: threadTs} : {}),
          initial_comment: `🔗 掲載先LP: ${d.href}`,
          file_uploads: [{file: s.path, filename: path.basename(s.path)}]
        }).catch(e => console.error(`⚠️ 画像アップロード失敗 (${s.path}):`, e.message));
      })));
    } catch (slackError) {
      console.error("❌ Slackへのメイン送信ブロックでエラーが発生しました:", slackError.message);
    }
  } else {
    console.log("⚠️ SLACK_BOT_TOKEN または SLACK_CHANNEL が未設定のためSlack送信をスキップしました。");
  }

  // 異常終了（exit code 1）は「実際の技術的エラー」があった場合のみ。
  // バナー未検出はトリガーにより正常に起こり得るため、それだけでは失敗扱いにしない。
  if (hasTechnicalError) {
    console.log("⚠️ 画面取得エラーが発生したLPがあるため、意図的に exit code 1 で終了します。");
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
