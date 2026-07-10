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
async function collectImageSrcs(page) {
  const imageSrcs = [ ];
  for (const frame of page.frames()) {
    try {
      const srcs = await frame.evaluate(() => {
        const imgSrcs = Array.from(document.querySelectorAll('img'))
          .filter((img) => img.complete && img.naturalWidth > 0)
          .map((img) => img.currentSrc || img.src);

        const bgSrcs = Array.from(document.querySelectorAll('*'))
          .map((el) => {
            const bg = getComputedStyle(el).backgroundImage;
            const m = bg && bg.match(/url\(["']?(.*?)["']?\)/);
            return m ? m[1] : null;
          })
          .filter(Boolean);

        return [...imgSrcs, ...bgSrcs].filter((src) => src && ! src.startsWith('data:'));
      });
      imageSrcs.push(...srcs);
    } catch (e) {}
  }
  return [...new Set(imageSrcs)];
}

async function main() {
  LP_URLS = required('LP_URL').split(',').map(url => url.trim());
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

  const browser = await chromium.launch({
    args: ['--disable-features=IsolateOrigins,site-per-process']
  });
  const viewports = [
    {name: 'PC', context: {viewport: {width: 1280, height: 800}, deviceScaleFactor: 1}},
    {name: 'SP', context: devices['iPhone 13']},
  ];
  const allResults = [ ];
  let hasTechnicalError = false;

  for (let lpIdx = 0; lpIdx < LP_URLS.length; lpIdx++) {
    const lpUrl = LP_URLS[lpIdx];
    console.log(`Processing LP [${lpIdx + 1}/${LP_URLS.length}]: ${lpUrl}`);

    let results = {PC: {}, SP: {}};
    let screenshots = {PC: {}, SP: {}};
    let navError = {PC: false, SP: false};

    // 💡 リトライ制御用（最大3回スキャンを試みます）
    const MAX_RETRIES = 3;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 1) {
        console.log(`\n⚠️ 該当デバイスで想定バナーが未検出のため、再スキャンを実行します（試行 ${attempt}/${MAX_RETRIES}）`);
        // ページ読み込み負荷を考慮し、5秒待機してから開き直す
        await new Promise(resolve => setTimeout(resolve, 5000));
      }

      results = {PC: {}, SP: {}};
      screenshots = {PC: {}, SP: {}};
      navError = {PC: false, SP: false};

      for (const v of viewports) {
        const ctx = await browser.newContext(v.context);
        const page = await ctx.newPage();
        try {
          await page.goto(lpUrl, {waitUntil: 'load', timeout: 120000});
          await hideOverlays(page);
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

          const uniqueSrcs = await collectImageSrcs(page);
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
          console.error(`Failed to process LP ${lpUrl} (${v.name}):`, err);
          navError[v.name] = true;
          for (const b of banners) {
            results[v.name][b.id] = {found: false, distance: Infinity, bestSrc: null};
          }
          screenshots[v.name] = {path: null, url: null};
        } finally {
          await ctx.close();
        }
      }

      // 💡 再スキャン判定：そのバナーの「想定デバイス」側で未検出のものがあるかだけをチェックする。
      // （例：SP専用バナーがPCで見つからなくても異常ではないため対象にしない）
      let shouldRetry = false;
      for (const b of banners) {
        const pcFound = results.PC[b.id]?.found;
        const spFound = results.SP[b.id]?.found;
        if (b.device === 'PC' && ! pcFound) {
          shouldRetry = true;
          console.log(`🔍 未検出バナー検知: 【${b.url}】(PC想定) がPC画面で見つかりません。`);
        } else if (b.device === 'SP' && ! spFound) {
          shouldRetry = true;
          console.log(`🔍 未検出バナー検知: 【${b.url}】(SP想定) がSP画面で見つかりません。`);
        } else if (b.device === 'UNKNOWN' && ! pcFound && ! spFound) {
          shouldRetry = true;
          console.log(`🔍 未検出バナー検知: 【${b.url}】(サイズ不明) がPC・SPともに見つかりません。`);
        }
      }

      if ( ! shouldRetry || navError.PC || navError.SP) {
        // ナビゲーション自体が失敗した場合はリトライしても解決しないためループを抜ける
        break;
      }

      if (attempt < MAX_RETRIES) {
        console.log(`❌ 試行 ${attempt}: 想定デバイス側でバナー未検出のため、ページを読み直して再スキャンします。`);
      } else {
        console.log(`❌ 最大リトライ回数（${MAX_RETRIES}回）に達しました。以降は検出結果をそのまま報告します。`);
      }
    }

    if (navError.PC || navError.SP) hasTechnicalError = true;
    allResults.push({lpUrl, lpIdx, results, screenshots, navError});
  }
  await browser.close();

  // ====== レポート生成 ======
  // 注意：トリガーによって表示バナーが変わる仕様のため、「未検出」を一律で異常扱いにしない。
  // あくまで「どのバナーがどちらの画面で検出されたか」を事実として報告する。
  const detailLines = [ ];
  allResults.forEach(item => {
    detailLines.push(`\n🌐 *LP*: ${item.lpUrl}`);

    if (item.navError.PC || item.navError.SP) {
      detailLines.push(`  🔥 *取得エラー*: ${item.navError.PC ? 'PC ' : ''}${item.navError.SP ? 'SP' : ''} の画面取得に失敗しました。`);
    }

    const foundPC = banners.filter(b => item.results.PC[b.id]?.found);
    const foundSP = banners.filter(b => item.results.SP[b.id]?.found);
    detailLines.push(`  🖥️ *PCで検出*: ${foundPC.length ? foundPC.map(b => `${b.url}(${b.width}x${b.height})`).join(', ') : 'なし'}`);
    detailLines.push(`  📱 *SPで検出*: ${foundSP.length ? foundSP.map(b => `${b.url}(${b.width}x${b.height})`).join(', ') : 'なし'}`);

    detailLines.push(`  --- バナー別詳細 ---`);
    banners.forEach(b => {
      const pcRes = item.results.PC[b.id];
      const spRes = item.results.SP[b.id];
      const pcLabel = b.device === 'SP' ? '─(対象外)' : (pcRes?.found ? `✅検出 (距離${pcRes.distance})` : `❌未検出 (距離${pcRes?.distance ?? '-'})`);
      const spLabel = b.device === 'PC' ? '─(対象外)' : (spRes?.found ? `✅検出 (距離${spRes.distance})` : `❌未検出 (距離${spRes?.distance ?? '-'})`);
      detailLines.push(`  【${b.url}】 ${b.width}x${b.height} / ${b.device}想定`);
      detailLines.push(`    PC: ${pcLabel}   SP: ${spLabel}`);
    });
  });

  const headline = hasTechnicalError
    ? '⚠️ 一部LPの画面取得でエラーが発生しました（下記詳細を確認してください）'
    : '📊 LPバナー掲載チェック結果（トリガーにより表示バナーは変動するため、未検出は必ずしも異常ではありません）';
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
