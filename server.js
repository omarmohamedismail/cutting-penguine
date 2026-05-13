const express = require('express');
const ytdl = require('@distube/ytdl-core');
const { spawn, execSync } = require('child_process');
const path = require('path');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// ── Check if yt-dlp is installed (more reliable than ytdl-core) ──
let HAS_YTDLP = false;
try {
  execSync('yt-dlp --version', { stdio: 'ignore' });
  HAS_YTDLP = true;
  console.log('✅ yt-dlp detected — will be used for YouTube downloads');
} catch {
  console.log('⚠️  yt-dlp not found — falling back to ytdl-core');
}

// ── Check FFmpeg ──
try {
  execSync('ffmpeg -version', { stdio: 'ignore' });
  console.log('✅ FFmpeg detected');
} catch {
  console.error('❌ FFmpeg not found! Install it from https://ffmpeg.org/download.html');
}

// ─────────────────────────────────────────────────────────────
// GET /api/info?url=<video_url>
// Returns: title, duration (seconds), thumbnail, type
// ─────────────────────────────────────────────────────────────
app.get('/api/info', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL مطلوب' });

  try {
    if (isYouTube(url)) {
      if (HAS_YTDLP) {
        const raw = execSync(`yt-dlp --dump-json --no-playlist "${url}"`, {
          timeout: 15000,
          encoding: 'utf8'
        });
        const info = JSON.parse(raw);
        return res.json({
          title: info.title,
          duration: info.duration,
          thumbnail: info.thumbnail,
          type: 'youtube',
          videoId: extractYouTubeId(url)
        });
      } else {
        const info = await ytdl.getInfo(url);
        const d = info.videoDetails;
        return res.json({
          title: d.title,
          duration: parseInt(d.lengthSeconds),
          thumbnail: d.thumbnails[d.thumbnails.length - 1]?.url,
          type: 'youtube',
          videoId: extractYouTubeId(url)
        });
      }
    } else {
      // Direct URL — just return what we can
      const name = decodeURIComponent(url.split('/').pop().split('?')[0]) || 'video';
      return res.json({ title: name, duration: null, thumbnail: null, type: 'direct' });
    }
  } catch (err) {
    console.error('[info]', err.message);
    res.status(500).json({ error: 'تعذّر جلب معلومات الفيديو: ' + err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/cut?url=&start=&end=&title=
// Streams the trimmed video as MP4 download
// ─────────────────────────────────────────────────────────────
app.get('/api/cut', async (req, res) => {
  const { url, start, end, title = 'video' } = req.query;
  if (!url) return res.status(400).json({ error: 'URL مطلوب' });

  const startSec = parseFloat(start) || 0;
  const endSec = parseFloat(end) || null;
  const duration = endSec !== null ? endSec - startSec : null;

  const safeName = (title + '_cut').replace(/[^\w\u0600-\u06FF\s.-]/g, '_').trim();
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}.mp4`);

  try {
    // ── YouTube via yt-dlp (most reliable) ──
    if (isYouTube(url) && HAS_YTDLP) {
      const ytArgs = [
        '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
        '--no-playlist',
        '--download-sections', `*${startSec}-${endSec ?? 9999999}`,
        '--force-keyframes-at-cuts',
        '-o', '-',
        url
      ];
      const ytProc = spawn('yt-dlp', ytArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
      ytProc.stdout.pipe(res);
      ytProc.stderr.on('data', d => process.stdout.write('[yt-dlp] ' + d));
      ytProc.on('error', err => { if (!res.headersSent) res.status(500).end(err.message); });
      req.on('close', () => ytProc.kill('SIGKILL'));
      return;
    }

    // ── YouTube via ytdl-core → ffmpeg ──
    if (isYouTube(url)) {
      const info = await ytdl.getInfo(url);
      const format = ytdl.chooseFormat(info.formats, {
        filter: 'audioandvideo',
        quality: 'highestvideo'
      });

      const sourceUrl = format?.url;
      const ffArgs = buildFfmpegArgs(sourceUrl || 'pipe:0', startSec, duration);

      const ff = spawn('ffmpeg', ffArgs, { stdio: ['pipe', 'pipe', 'pipe'] });

      if (!sourceUrl) {
        const stream = ytdl(url, { quality: 'highestvideo', filter: 'audioandvideo' });
        stream.pipe(ff.stdin);
      } else {
        ff.stdin.end();
      }

      ff.stdout.pipe(res);
      ff.stderr.on('data', () => {});
      ff.on('error', err => { if (!res.headersSent) res.status(500).end(err.message); });
      req.on('close', () => ff.kill('SIGKILL'));
      return;
    }

    // ── Direct URL → ffmpeg ──
    const ff = spawn('ffmpeg', buildFfmpegArgs(url, startSec, duration), {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    ff.stdout.pipe(res);
    ff.stderr.on('data', () => {});
    ff.on('error', err => { if (!res.headersSent) res.status(500).end(err.message); });
    req.on('close', () => ff.kill('SIGKILL'));

  } catch (err) {
    console.error('[cut]', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
function buildFfmpegArgs(input, startSec, duration) {
  return [
    '-ss', startSec.toFixed(3),
    '-i', input,
    ...(duration != null ? ['-t', duration.toFixed(3)] : []),
    '-c', 'copy',
    '-avoid_negative_ts', 'make_zero',
    '-movflags', '+faststart',
    '-f', 'mp4',
    'pipe:1'
  ];
}

function isYouTube(url) {
  return /youtube\.com|youtu\.be/i.test(url);
}

function extractYouTubeId(url) {
  const m = url.match(/(?:v=|youtu\.be\/)([^&?/]+)/);
  return m ? m[1] : null;
}

// ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🎬  Video Cutter → http://localhost:${PORT}\n`);
});
