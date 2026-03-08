import { spawn } from 'child_process';
import { app, BrowserWindow, dialog, ipcMain, protocol } from 'electron';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import ffmpeg from 'fluent-ffmpeg';
import { createReadStream, promises as fsp } from 'fs';
import https from 'https';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';

if (require('electron-squirrel-startup')) {
  app.quit();
}

// Setup static binaries for FFMPEG
if (ffmpegStatic) {
  ffmpeg.setFfmpegPath(ffmpegStatic.replace('app.asar', 'app.asar.unpacked'));
}
if (ffprobeStatic && ffprobeStatic.path) {
  ffmpeg.setFfprobePath(ffprobeStatic.path.replace('app.asar', 'app.asar.unpacked'));
}

const createWindow = () => {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#1e1e1e',
      symbolColor: '#ffffff',
    }
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }
};

// Register custom protocol to serve local media files securely
protocol.registerSchemesAsPrivileged([{
  scheme: 'media',
  privileges: { bypassCSP: true, stream: true, supportFetchAPI: true }
}]);

app.on('ready', () => {
  const MIME_MAP: Record<string, string> = {
    mp4: 'video/mp4', mov: 'video/quicktime', avi: 'video/x-msvideo',
    webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  };

  protocol.handle('media', async (request) => {
    // media://load/<encoded-path>
    const url = new URL(request.url);
    const filePath = decodeURIComponent(url.pathname).replace(/^\/+/, '');

    let fileSize: number;
    try {
      const stats = await fsp.stat(filePath);
      fileSize = stats.size;
    } catch {
      return new Response('Not Found', { status: 404 });
    }

    const ext = path.extname(filePath).toLowerCase().slice(1);
    const contentType = MIME_MAP[ext] || 'application/octet-stream';

    // Handle Range requests — required for video seeking
    const rangeHeader = request.headers.get('range');
    if (rangeHeader) {
      const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
      if (match) {
        const start = parseInt(match[1], 10);
        const end = match[2] ? parseInt(match[2], 10) : fileSize - 1;
        const chunkSize = end - start + 1;
        const nodeStream = createReadStream(filePath, { start, end });
        return new Response(Readable.toWeb(nodeStream) as ReadableStream, {
          status: 206,
          headers: {
            'Content-Type': contentType,
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Content-Length': String(chunkSize),
            'Accept-Ranges': 'bytes',
          },
        });
      }
    }

    // Full file response with Content-Length so Chromium knows it's seekable
    const nodeStream = createReadStream(filePath);
    return new Response(Readable.toWeb(nodeStream) as ReadableStream, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(fileSize),
        'Accept-Ranges': 'bytes',
      },
    });
  });

  createWindow();

  ipcMain.handle('dialog:openFile', async () => {
    const prefs = await loadPrefs();
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      defaultPath: prefs.lastImportDir || undefined,
      filters: [{ name: 'Media', extensions: ['mp4', 'avi', 'mov', 'webm', 'mp3', 'wav', 'png', 'jpg'] }]
    });
    if (canceled) return [];

    await savePrefs({ ...prefs, lastImportDir: path.dirname(filePaths[0]) });
    
    return filePaths.map(fp => ({
      path: fp,
      name: path.basename(fp),
      type: fp.match(/\.(mp3|wav)$/i) ? 'audio' : 
            fp.match(/\.(png|jpg|jpeg)$/i) ? 'image' : 'video'
    }));
  });

  ipcMain.handle('ffmpeg:getInfo', async (_, filePath) => {
    return new Promise((resolve) => {
      ffmpeg.ffprobe(filePath, (err, metadata) => {
        if (err || !metadata) {
          console.error("FFProbe error:", err);
          resolve({ duration: 10 }); 
        } else {
          resolve({ duration: metadata.format.duration || 10 });
        }
      });
    });
  });

  // Thumbnail generation: extract a frame at a given timestamp, return base64 JPEG
  const thumbCache = new Map<string, string>();
  const thumbDir = path.join(os.tmpdir(), 'clipvid-thumbs');
  fsp.mkdir(thumbDir, { recursive: true }).catch(() => {});

  ipcMain.handle('ffmpeg:getThumbnail', async (_, filePath: string, timestamp: number) => {
    const cacheKey = `${filePath}@${timestamp.toFixed(2)}`;
    if (thumbCache.has(cacheKey)) return thumbCache.get(cacheKey)!;

    const outFile = path.join(thumbDir, `thumb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.jpg`);
    try {
      await new Promise<void>((resolve, reject) => {
        ffmpeg(filePath)
          .seekInput(timestamp)
          .frames(1)
          .size('160x90')
          .outputOptions(['-q:v', '8'])
          .output(outFile)
          .on('end', () => resolve())
          .on('error', (err) => reject(err))
          .run();
      });

      const buf = await fsp.readFile(outFile);
      const dataUrl = `data:image/jpeg;base64,${buf.toString('base64')}`;
      thumbCache.set(cacheKey, dataUrl);
      // Clean up temp file
      fsp.unlink(outFile).catch(() => {});
      return dataUrl;
    } catch {
      return '';
    }
  });

  // ── Persist last export directory ──
  const prefsPath = path.join(app.getPath('userData'), 'clipvid-prefs.json');
  async function loadPrefs(): Promise<Record<string, any>> {
    try { return JSON.parse(await fsp.readFile(prefsPath, 'utf-8')); } catch { return {}; }
  }
  async function savePrefs(p: Record<string, any>) {
    await fsp.writeFile(prefsPath, JSON.stringify(p), 'utf-8');
  }

  ipcMain.handle('dialog:showExportDialog', async () => {
    const prefs = await loadPrefs();
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Export Video',
      defaultPath: path.join(prefs.lastExportDir || app.getPath('desktop'), 'export.mp4'),
      filters: [{ name: 'MP4 Video', extensions: ['mp4'] }],
    });
    if (canceled || !filePath) return null;
    await savePrefs({ ...prefs, lastExportDir: path.dirname(filePath) });
    return filePath;
  });

  // ── Probe resolution of a video file ──
  function probeSize(filePath: string): Promise<{ width: number; height: number }> {
    return new Promise((resolve) => {
      ffmpeg.ffprobe(filePath, (err, metadata) => {
        if (err || !metadata) { resolve({ width: 1920, height: 1080 }); return; }
        const vs = metadata.streams.find((s: any) => s.codec_type === 'video');
        resolve({ width: vs?.width || 1920, height: vs?.height || 1080 });
      });
    });
  }

  // ── ASS subtitle helpers ──
  function hexToASSColor(hex: string): string {
    if (!hex || hex === 'transparent') return '&HFF000000';
    const c = hex.replace('#', '');
    const r = c.slice(0, 2).toUpperCase();
    const g = c.slice(2, 4).toUpperCase();
    const b = c.slice(4, 6).toUpperCase();
    return `&H00${b}${g}${r}`;
  }

  function rgbaToASSColor(rgba: string): string {
    const m = rgba.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)/);
    if (!m) return '&HFF000000';
    const r = parseInt(m[1]).toString(16).padStart(2, '0').toUpperCase();
    const g = parseInt(m[2]).toString(16).padStart(2, '0').toUpperCase();
    const b = parseInt(m[3]).toString(16).padStart(2, '0').toUpperCase();
    const opacity = m[4] ? parseFloat(m[4]) : 1;
    const a = Math.round((1 - opacity) * 255).toString(16).padStart(2, '0').toUpperCase();
    return `&H${a}${b}${g}${r}`;
  }

  function toASSTime(secs: number): string {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    return `${h}:${m.toString().padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
  }

  // ── Google Fonts download for subtitle burn-in ──
  const EXPORT_FONT_FAMILIES = [
    'Montserrat', 'Poppins', 'Bangers', 'Bebas Neue',
    'Oswald', 'Luckiest Guy', 'Permanent Marker', 'Fredoka',
  ];

  function httpGetText(url: string, headers?: Record<string, string>): Promise<string> {
    return new Promise((resolve, reject) => {
      const doGet = (u: string, redirects = 0) => {
        if (redirects > 5) { reject(new Error('Too many redirects')); return; }
        https.get(u, { headers: headers || {} }, (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            doGet(res.headers.location, redirects + 1);
            return;
          }
          let data = '';
          res.on('data', (c: Buffer) => { data += c.toString(); });
          res.on('end', () => resolve(data));
          res.on('error', reject);
        }).on('error', reject);
      };
      doGet(url);
    });
  }

  function httpGetBuffer(url: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doGet = (u: string, redirects = 0) => {
        if (redirects > 5) { reject(new Error('Too many redirects')); return; }
        https.get(u, (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            doGet(res.headers.location, redirects + 1);
            return;
          }
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks)));
          res.on('error', reject);
        }).on('error', reject);
      };
      doGet(url);
    });
  }

  async function ensureExportFonts(): Promise<string> {
    const fontsDir = path.join(app.getPath('userData'), 'export-fonts');
    await fsp.mkdir(fontsDir, { recursive: true });

    // Check if we already have at least one .ttf per family
    const marker = path.join(fontsDir, '.cached');
    let needsDownload = false;
    try {
      await fsp.access(marker);
      // Verify at least one TTF per family actually exists
      for (const family of EXPORT_FONT_FAMILIES) {
        const safeName = family.replace(/\s+/g, '');
        const files = await fsp.readdir(fontsDir);
        const hasTTF = files.some(f => f.startsWith(safeName) && f.endsWith('.ttf'));
        if (!hasTTF) { needsDownload = true; break; }
      }
    } catch {
      needsDownload = true;
    }

    if (!needsDownload) {
      console.log('Export fonts already cached.');
      return fontsDir;
    }

    // Delete stale marker
    try { await fsp.unlink(marker); } catch {}

    console.log('Downloading Google Fonts for export...');

    let downloadedCount = 0;
    for (const family of EXPORT_FONT_FAMILIES) {
      try {
        // Request with Safari UA to get TTF format (modern Chrome gets woff2, IE gets eot)
        const weights = '400;600;700;800;900';
        const cssUrl = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@${weights}&display=swap`;
        const css = await httpGetText(cssUrl, {
          'User-Agent': 'Safari/534.30',
        });

        // Extract all TTF URLs with their weights
        const blocks = css.split('@font-face');
        let familyDownloaded = 0;
        for (const block of blocks) {
          const wMatch = block.match(/font-weight:\s*(\d+)/);
          const uMatch = block.match(/url\((https:\/\/[^)]+\.ttf[^)]*)\)/);
          if (!wMatch || !uMatch) continue;

          const weight = wMatch[1];
          const url = uMatch[1];
          const safeName = family.replace(/\s+/g, '');
          const filePath = path.join(fontsDir, `${safeName}-${weight}.ttf`);

          try { await fsp.access(filePath); familyDownloaded++; continue; } catch {}

          const buf = await httpGetBuffer(url);
          if (buf.length < 1000) {
            console.warn(`  Skipping ${safeName}-${weight}.ttf — too small (${buf.length} bytes)`);
            continue;
          }
          await fsp.writeFile(filePath, buf);
          console.log(`  Downloaded ${safeName}-${weight}.ttf (${(buf.length / 1024).toFixed(0)} KB)`);
          familyDownloaded++;
          downloadedCount++;
        }
        if (familyDownloaded === 0) {
          console.warn(`  No TTF files found for "${family}" — CSS response may have changed`);
        }
      } catch (err: any) {
        console.warn(`  Failed to download "${family}":`, err.message);
      }
    }

    if (downloadedCount > 0) {
      await fsp.writeFile(marker, 'ok', 'utf-8');
    }
    console.log(`Font download complete (${downloadedCount} new files).`);
    return fontsDir;
  }

  ipcMain.handle('ffmpeg:exportVideo', async (_, timelineData: any, returnPath: string) => {
    try {
      console.log("Exporting to:", returnPath);

      // Gather all video clips across all video tracks, sorted by startOffset
      const videoClips: any[] = [];
      for (const track of timelineData.tracks) {
        if (track.type !== 'video') continue;
        for (const clip of track.clips) videoClips.push(clip);
      }
      videoClips.sort((a: any, b: any) => a.startOffset - b.startOffset);

      if (videoClips.length === 0) {
        return { success: false, error: 'No video clips to render.' };
      }

      // Gather all audio-only clips across audio tracks, sorted by startOffset
      const audioClips: any[] = [];
      for (const track of timelineData.tracks) {
        if (track.type !== 'audio' || track.muted) continue;
        for (const clip of track.clips) audioClips.push(clip);
      }
      audioClips.sort((a: any, b: any) => a.startOffset - b.startOffset);

      // Detect output resolution from the first video clip
      const { width: outW, height: outH } = await probeSize(videoClips[0].path);
      console.log(`Export resolution: ${outW}x${outH}`);

      const tempDir = path.join(os.tmpdir(), `clipvid-export-${Date.now()}`);
      await fsp.mkdir(tempDir, { recursive: true });

      // ── Render video segments ──
      const videoSegFiles: string[] = [];
      for (let i = 0; i < videoClips.length; i++) {
        const clip = videoClips[i];
        const srcStart = clip.sourceStart || 0;
        const srcDuration = clip.duration * (clip.speedMultiplier || 1);
        const speed = clip.speedMultiplier || 1;
        const volume = clip.volume ?? 1;
        const segPath = path.join(tempDir, `vseg_${i}.mp4`);
        videoSegFiles.push(segPath);

        await new Promise<void>((resolve, reject) => {
          const cmd = ffmpeg(clip.path)
            .seekInput(srcStart)
            .inputOptions(['-t', String(srcDuration)]);

          const vFilters: string[] = [];
          if (speed !== 1) vFilters.push(`setpts=${(1 / speed).toFixed(4)}*PTS`);
          vFilters.push(`scale=${outW}:${outH}:force_original_aspect_ratio=decrease`);
          vFilters.push(`pad=${outW}:${outH}:(ow-iw)/2:(oh-ih)/2:black`);

          const aFilters: string[] = [];
          if (speed !== 1) aFilters.push(`atempo=${speed}`);
          if (volume !== 1) aFilters.push(`volume=${volume.toFixed(2)}`);

          cmd.videoFilters(vFilters);
          if (aFilters.length) cmd.audioFilters(aFilters);
          cmd.outputOptions([
              '-c:v libx264', '-preset fast', '-crf 22', '-pix_fmt yuv420p', '-r 30',
              '-c:a aac', '-b:a 192k', '-ar 44100', '-ac 2',
            ])
            .save(segPath)
            .on('end', () => resolve())
            .on('error', (err: any) => reject(err));
        });
      }

      // ── Ensure all segments have an audio stream (needed for acrossfade) ──
      for (let i = 0; i < videoSegFiles.length; i++) {
        const hasAudio = await new Promise<boolean>((resolve) => {
          ffmpeg.ffprobe(videoSegFiles[i], (err, metadata) => {
            if (err || !metadata) { resolve(false); return; }
            resolve(metadata.streams.some((s: any) => s.codec_type === 'audio'));
          });
        });
        if (!hasAudio) {
          const withAudioPath = path.join(tempDir, `vseg_${i}_a.mp4`);
          await new Promise<void>((resolve, reject) => {
            ffmpeg(videoSegFiles[i])
              .input('anullsrc=channel_layout=stereo:sample_rate=44100')
              .inputOptions(['-f lavfi'])
              .outputOptions(['-c:v copy', '-c:a aac', '-b:a 192k', '-shortest'])
              .save(withAudioPath)
              .on('end', () => resolve())
              .on('error', (err: any) => reject(err));
          });
          videoSegFiles[i] = withAudioPath;
        }
      }

      // ── Merge video segments (transition-aware) ──
      const mergedVideo = path.join(tempDir, 'merged_video.mp4');
      const hasTransitions = videoClips.some((c: any, idx: number) => idx > 0 && c.transition);

      if (videoSegFiles.length === 1) {
        // Single segment — use directly
        await fsp.copyFile(videoSegFiles[0], mergedVideo);

      } else if (!hasTransitions) {
        // No transitions — simple concat (fast, no re-encode)
        const videoConcatList = path.join(tempDir, 'vlist.txt');
        await fsp.writeFile(videoConcatList,
          videoSegFiles.map(f => `file '${f.replace(/\\/g, '/')}'`).join('\n'), 'utf-8');

        await new Promise<void>((resolve, reject) => {
          ffmpeg()
            .input(videoConcatList)
            .inputOptions(['-f concat', '-safe 0'])
            .outputOptions(['-c copy'])
            .save(mergedVideo)
            .on('end', () => resolve())
            .on('error', (err: any) => reject(err));
        });

      } else {
        // ── Transitions present — build xfade (video) + adelay/amix (audio) ──
        const XFADE_MAP: Record<string, string> = {
          'fade': 'fadeblack', 'dissolve': 'dissolve', 'flash': 'fadewhite',
          'wipe-left': 'wipeleft', 'wipe-right': 'wiperight',
          'slide-left': 'slideleft', 'slide-right': 'slideright',
          'zoom': 'zoomin', 'blur': 'smoothleft',
        };

        // Get accurate rendered durations for each segment
        const segDurations: number[] = await Promise.all(
          videoSegFiles.map(f => new Promise<number>((resolve) => {
            ffmpeg.ffprobe(f, (err, metadata) => {
              if (err || !metadata?.format?.duration) resolve(5);
              else resolve(Number(metadata.format.duration));
            });
          }))
        );

        // Compute clamped transition durations between each pair
        // transitionDurs[i] = overlap between seg i and seg i+1
        const transitionDurs: number[] = [];
        for (let i = 0; i < videoSegFiles.length - 1; i++) {
          const nextClip = videoClips[i + 1];
          const trans = nextClip.transition;
          if (trans && trans.duration > 0) {
            transitionDurs.push(
              Math.min(trans.duration, segDurations[i] * 0.8, segDurations[i + 1] * 0.8)
            );
          } else {
            transitionDurs.push(0);
          }
        }

        // ── VIDEO: xfade chain ──
        const filters: string[] = [];
        let lastV = '0:v';
        // Subtract a small safety margin from probed durations to avoid
        // xfade offset landing exactly at (or past) the actual frame boundary
        const SAFETY = 0.05;
        let runningDuration = segDurations[0] - SAFETY;

        for (let i = 0; i < videoSegFiles.length - 1; i++) {
          const isLast = i === videoSegFiles.length - 2;
          const outV = isLast ? 'vout' : `v${i}`;
          const T = transitionDurs[i];

          if (T > 0) {
            const nextClip = videoClips[i + 1];
            const tName = XFADE_MAP[nextClip.transition?.type] || 'fadeblack';
            const offset = Math.max(0, runningDuration - T);
            filters.push(
              `[${lastV}][${i + 1}:v]xfade=transition=${tName}:duration=${T.toFixed(4)}:offset=${offset.toFixed(4)}[${outV}]`
            );
            runningDuration = offset + segDurations[i + 1] - SAFETY;
          } else {
            // Hard cut: minimal 2-frame crossfade at 30fps
            const minD = 2 / 30;
            const offset = Math.max(0, runningDuration - minD);
            filters.push(
              `[${lastV}][${i + 1}:v]xfade=transition=fade:duration=${minD.toFixed(4)}:offset=${offset.toFixed(4)}[${outV}]`
            );
            runningDuration = offset + segDurations[i + 1] - SAFETY;
          }
          lastV = outV;
        }

        // ── AUDIO: afade + adelay + amix ──
        let audioPos = 0;
        for (let i = 0; i < videoSegFiles.length; i++) {
          const parts: string[] = [];

          // Fade-in if there's a transition before this segment
          if (i > 0 && transitionDurs[i - 1] > 0) {
            parts.push(`afade=t=in:d=${transitionDurs[i - 1].toFixed(4)}`);
          }
          // Fade-out if there's a transition after this segment
          if (i < videoSegFiles.length - 1 && transitionDurs[i] > 0) {
            const st = Math.max(0, segDurations[i] - transitionDurs[i]);
            parts.push(`afade=t=out:st=${st.toFixed(4)}:d=${transitionDurs[i].toFixed(4)}`);
          }

          // Position in timeline
          const delayMs = Math.round(audioPos * 1000);
          if (delayMs > 0) parts.push(`adelay=${delayMs}|${delayMs}`);

          filters.push(`[${i}:a]${parts.length > 0 ? parts.join(',') : 'anull'}[a${i}]`);

          // Advance by segment duration minus overlap with next
          if (i < videoSegFiles.length - 1) {
            const T = transitionDurs[i] > 0 ? transitionDurs[i] : 1 / 30;
            audioPos += segDurations[i] - T;
          }
        }

        // Mix all audio streams
        const amixInputs = videoSegFiles.map((_, i) => `[a${i}]`).join('');
        filters.push(
          `${amixInputs}amix=inputs=${videoSegFiles.length}:duration=longest:dropout_transition=0[aout]`
        );

        console.log('Export filter chain:\n' + filters.join(';\n'));

        const cmd = ffmpeg();
        for (const seg of videoSegFiles) cmd.input(seg);

        await new Promise<void>((resolve, reject) => {
          cmd.complexFilter(filters.join(';'))
            .outputOptions([
              '-map [vout]', '-map [aout]',
              '-c:v libx264', '-preset fast', '-crf 22', '-pix_fmt yuv420p',
              '-c:a aac', '-b:a 192k',
            ])
            .save(mergedVideo)
            .on('start', (c: string) => console.log('Merge cmd:', c))
            .on('end', () => resolve())
            .on('error', (err: any) => reject(err));
        });
      }

      // ── Burn in subtitles ──
      const subtitles: any[] = timelineData.subtitles || [];
      if (subtitles.length > 0) {
        console.log(`Burning in ${subtitles.length} subtitle(s)...`);

        // Ensure Google Fonts are downloaded for ffmpeg to use
        let fontsDir: string | null = null;
        try {
          fontsDir = await ensureExportFonts();
        } catch (err: any) {
          console.warn('Font download failed, export will use system fonts:', err.message);
        }

        const assFile = path.join(tempDir, 'subtitles.ass');
        const REF_HEIGHT = 480; // assumed preview container height
        const scaleFactor = outH / REF_HEIGHT;

        // ── Timeline-to-export time mapping ──
        // The merged video concatenates clips back-to-back (gaps removed,
        // transitions overlapping). Subtitle times must be remapped from
        // their timeline positions to the corresponding export positions.
        const clipExportStart: number[] = [0];
        for (let i = 1; i < videoClips.length; i++) {
          let overlap = 0;
          const trans = videoClips[i].transition;
          if (trans && trans.duration > 0) {
            overlap = Math.min(trans.duration, videoClips[i - 1].duration * 0.8, videoClips[i].duration * 0.8);
          }
          clipExportStart[i] = clipExportStart[i - 1] + videoClips[i - 1].duration - overlap;
        }

        function timelineToExport(t: number): number {
          for (let i = videoClips.length - 1; i >= 0; i--) {
            const clip = videoClips[i];
            if (t >= clip.startOffset) {
              return clipExportStart[i] + (t - clip.startOffset);
            }
          }
          return t; // before first clip — keep as-is
        }

        // --- Generate ASS subtitle file ---
        const assLines: string[] = [
          '[Script Info]',
          'ScriptType: v4.00+',
          `PlayResX: ${outW}`,
          `PlayResY: ${outH}`,
          'WrapStyle: 0',
          '',
          '[V4+ Styles]',
          'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
        ];

        for (let i = 0; i < subtitles.length; i++) {
          const sub = subtitles[i];
          const s = sub.style || {};
          const fontSize = Math.round((s.fontSize || 54) * scaleFactor);
          const primaryColor = hexToASSColor(s.color || '#ffffff');
          const outlineColor = (!s.strokeColor || s.strokeColor === 'transparent')
            ? '&HFF000000' : hexToASSColor(s.strokeColor);
          const bgColor = (!s.backgroundColor || s.backgroundColor === 'transparent')
            ? '&HFF000000' : rgbaToASSColor(s.backgroundColor);
          const fontWeight = s.fontWeight || 400;
          const bold = fontWeight >= 700 ? -1 : 0;
          const borderStyle = (s.backgroundColor && s.backgroundColor !== 'transparent') ? 3 : 1;
          const outline = Math.round((s.strokeWidth || 0) * scaleFactor);
          const spacing = Math.round((s.letterSpacing || 0) * scaleFactor);
          const hasCustomPos = s.customX != null && s.customY != null;
          let alignment = 2; // bottom-center
          if (hasCustomPos) { alignment = 5; }
          else if (s.position === 'top') { alignment = 8; }
          else if (s.position === 'center') { alignment = 5; }

          let marginV = 0;
          if (!hasCustomPos) {
            if (s.position === 'bottom' || !s.position) marginV = Math.round(outH * 0.10);
            else if (s.position === 'top') marginV = Math.round(outH * 0.06);
          }

          const marginLR = Math.round(outW * (1 - (s.maxWidth || 90) / 100) / 2);

          assLines.push(
            `Style: Sub${i},${s.fontFamily || 'Arial'},${fontSize},${primaryColor},&H000000FF,${outlineColor},${bgColor},${bold},0,0,0,100,100,${spacing},0,${borderStyle},${outline},0,${alignment},${marginLR},${marginLR},${marginV},1`
          );
        }

        assLines.push('');
        assLines.push('[Events]');
        assLines.push('Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text');

        // Helper: convert hex to ASS override color format (&HBBGGRR&)
        function hexToASSOverride(hex: string): string {
          if (!hex || hex === 'transparent') return '&H000000&';
          const c = hex.replace('#', '');
          const r = c.slice(0, 2).toUpperCase();
          const g = c.slice(2, 4).toUpperCase();
          const b = c.slice(4, 6).toUpperCase();
          return `&H${b}${g}${r}&`;
        }

        for (let i = 0; i < subtitles.length; i++) {
          const sub = subtitles[i];
          const s = sub.style || {};
          const rawText: string = s.uppercase ? (sub.text || '').toUpperCase() : (sub.text || '');
          const animation = s.animation || 'pop';

          // Position and weight override tags
          const posTags: string[] = [];
          if (s.customX != null && s.customY != null) {
            const px = Math.round((s.customX / 100) * outW);
            const py = Math.round((s.customY / 100) * outH);
            posTags.push(`\\pos(${px},${py})`);
          }
          const fontWeight = s.fontWeight || 400;
          if (fontWeight !== 400 && fontWeight !== 700) {
            posTags.push(`\\b${fontWeight}`);
          }

          // Remap subtitle times from timeline to export video
          const exportStart = timelineToExport(sub.startTime);
          const exportEnd = timelineToExport(sub.endTime);

          if (animation === 'none') {
            // No animation — show all text at once
            const text = rawText.replace(/\n/g, '\\N');
            const prefix = posTags.length > 0 ? `{${posTags.join('')}}` : '';
            assLines.push(
              `Dialogue: 0,${toASSTime(exportStart)},${toASSTime(exportEnd)},Sub${i},,0,0,0,,${prefix}${text}`
            );
          } else {
            // Per-word animation matching the preview's WordByWordText timing
            const words = rawText.split(/\s+/).filter(w => w.length > 0);
            if (words.length === 0) continue;

            const duration = sub.endTime - sub.startTime;
            const durationMs = Math.round(duration * 1000);
            const revealFrac = 0.70;
            const revealMs = Math.round(durationMs * revealFrac);
            const exitStartMs = Math.round(durationMs * 0.85);

            // Weight by character length (same as WordByWordText)
            const wordLens = words.map(w => w.length);
            const totalLen = wordLens.reduce((a, b) => a + b, 0);
            const avgLen = totalLen / words.length;
            const wWeights = wordLens.map(l => Math.max(0.4, 0.5 + 0.5 * (l / avgLen)));
            const totalWeight = wWeights.reduce((a, b) => a + b, 0);

            const wordStarts: number[] = [];
            let cumWeight = 0;
            for (let w = 0; w < words.length; w++) {
              wordStarts.push(cumWeight / totalWeight);
              cumWeight += wWeights[w];
            }

            const wordAnimFrac = Math.min(0.15, 1.2 / words.length);
            const wordAnimMs = Math.max(80, Math.round(revealMs * wordAnimFrac));

            const highlightClr = hexToASSOverride(s.highlightColor || '#8b5cf6');
            const primaryClr = hexToASSOverride(s.color || '#ffffff');

            let taggedText = '';
            for (let w = 0; w < words.length; w++) {
              const wStartMs = Math.round(wordStarts[w] * revealMs);
              const wEndMs = Math.min(revealMs, wStartMs + wordAnimMs);
              const nextWStartMs = w < words.length - 1
                ? Math.round(wordStarts[w + 1] * revealMs)
                : revealMs;

              let tags = '';
              // First word carries position/weight tags
              if (w === 0) tags += posTags.join('');

              // Per-word reveal: start invisible, transition to visible
              tags += `\\alpha&HFF&\\t(${wStartMs},${wEndMs},\\alpha&H00&)`;

              // Exit fade (last 15%)
              tags += `\\t(${exitStartMs},${durationMs},\\alpha&HFF&)`;

              // Highlight color: flash highlight when this word is active, revert at next word
              tags += `\\t(${wEndMs},${Math.min(wEndMs + 50, durationMs)},\\1c${highlightClr})`;
              tags += `\\t(${nextWStartMs},${Math.min(nextWStartMs + 50, durationMs)},\\1c${primaryClr})`;

              taggedText += `{${tags}}${words[w]}`;
              if (w < words.length - 1) taggedText += ' ';
            }

            assLines.push(
              `Dialogue: 0,${toASSTime(exportStart)},${toASSTime(exportEnd)},Sub${i},,0,0,0,,${taggedText}`
            );
          }
        }

        await fsp.writeFile(assFile, assLines.join('\n'), 'utf-8');

        // Apply subtitles filter (re-encode video, copy audio)
        const subtitledVideo = path.join(tempDir, 'subtitled.mp4');

        // Copy fonts into temp dir so we can reference them with a simple path
        if (fontsDir) {
          try {
            const fontFiles = await fsp.readdir(fontsDir);
            let copiedCount = 0;
            for (const f of fontFiles) {
              if (f.endsWith('.ttf')) {
                await fsp.copyFile(path.join(fontsDir, f), path.join(tempDir, f));
                copiedCount++;
              }
            }
            console.log(`Copied ${copiedCount} font files to temp dir.`);
          } catch (err: any) {
            console.warn('Failed to copy fonts to temp dir:', err.message);
          }
        } else {
          console.warn('No fonts directory available — subtitles will use system fonts.');
        }

        // Spawn ffmpeg directly with cwd=tempDir so all paths are relative (no Windows colon escaping issues)
        const ffmpegBin = ffmpegStatic!.replace('app.asar', 'app.asar.unpacked');
        const mergedBasename = path.basename(mergedVideo);
        const subtitledBasename = path.basename(subtitledVideo);
        const spawnArgs = [
          '-i', mergedBasename,
          '-vf', 'subtitles=subtitles.ass:fontsdir=.',
          '-c:v', 'libx264', '-preset', 'fast', '-crf', '22', '-pix_fmt', 'yuv420p',
          '-c:a', 'copy',
          '-y', subtitledBasename,
        ];
        console.log('Subtitle burn cmd:', ffmpegBin, spawnArgs.join(' '));

        await new Promise<void>((resolve, reject) => {
          const proc = spawn(ffmpegBin, spawnArgs, { cwd: tempDir });
          let stderr = '';
          proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
          proc.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-500)}`));
          });
          proc.on('error', reject);
        });

        await fsp.unlink(mergedVideo);
        await fsp.rename(subtitledVideo, mergedVideo);
        console.log('Subtitles burned in successfully.');
      }

      // ── If no extra audio clips, we're done ──
      if (audioClips.length === 0) {
        await fsp.copyFile(mergedVideo, returnPath);
      } else {
        // Render audio-only segments and mix
        const audioSegFiles: string[] = [];
        for (let i = 0; i < audioClips.length; i++) {
          const clip = audioClips[i];
          const srcStart = clip.sourceStart || 0;
          const srcDuration = clip.duration * (clip.speedMultiplier || 1);
          const speed = clip.speedMultiplier || 1;
          const volume = clip.volume ?? 1;
          const segPath = path.join(tempDir, `aseg_${i}.wav`);
          audioSegFiles.push(segPath);

          await new Promise<void>((resolve, reject) => {
            const cmd = ffmpeg(clip.path)
              .seekInput(srcStart)
              .inputOptions(['-t', String(srcDuration)])
              .noVideo();

            const aFilters: string[] = [];
            if (speed !== 1) aFilters.push(`atempo=${speed}`);
            if (volume !== 1) aFilters.push(`volume=${volume.toFixed(2)}`);
            // Pad silence at the start to place the audio clip at the right timeline position
            const delayMs = Math.round(clip.startOffset * 1000);
            if (delayMs > 0) aFilters.push(`adelay=${delayMs}|${delayMs}`);
            if (aFilters.length) cmd.audioFilters(aFilters);

            cmd.outputOptions(['-c:a pcm_s16le'])
              .save(segPath)
              .on('end', () => resolve())
              .on('error', (err: any) => reject(err));
          });
        }

        // Mix: merged video + all audio-only segments via amix
        const cmd = ffmpeg().input(mergedVideo);
        for (const af of audioSegFiles) cmd.input(af);

        const inputCount = 1 + audioSegFiles.length;
        // Map video from first input, merge all audio streams
        const filterParts: string[] = [];
        for (let i = 0; i < inputCount; i++) filterParts.push(`[${i}:a]`);
        const amixFilter = `${filterParts.join('')}amix=inputs=${inputCount}:duration=longest[aout]`;

        await new Promise<void>((resolve, reject) => {
          cmd.complexFilter([amixFilter])
            .outputOptions([
              '-map 0:v',
              '-map [aout]',
              '-c:v copy',
              '-c:a aac',
              '-b:a 192k',
            ])
            .save(returnPath)
            .on('end', () => resolve())
            .on('error', (err: any) => reject(err));
        });
      }

      // Cleanup temp
      const allTemp = await fsp.readdir(tempDir);
      for (const f of allTemp) fsp.unlink(path.join(tempDir, f)).catch(() => {});
      fsp.rmdir(tempDir).catch(() => {});

      return { success: true, path: returnPath };
    } catch (err: any) {
      console.error("FFMPEG Export error:", err);
      return { success: false, error: err.message || String(err) };
    }
  });

  // ══════════════════════════════════════════════════════════════
  //  TRANSCRIPTION — Extract subtitles from video using Whisper
  // ══════════════════════════════════════════════════════════════

  let whisperPipeline: any = null;

  /** Extract audio from a video file to 16 kHz mono WAV (Whisper input format) */
  async function extractAudioWav(videoPath: string, sourceStart?: number, sourceDuration?: number): Promise<string> {
    const outPath = path.join(os.tmpdir(), `clipvid-audio-${Date.now()}.wav`);
    return new Promise((resolve, reject) => {
      const cmd = ffmpeg(videoPath);
      if (sourceStart != null && sourceStart > 0) cmd.seekInput(sourceStart);
      if (sourceDuration != null && sourceDuration > 0) cmd.duration(sourceDuration);
      cmd
        .noVideo()
        .audioChannels(1)
        .audioFrequency(16000)
        .format('wav')
        .output(outPath)
        .on('end', () => resolve(outPath))
        .on('error', (err) => reject(err))
        .run();
    });
  }

  ipcMain.handle('transcribe:extractSubtitles', async (event, filePath: string, timelineOffset: number, sourceStart?: number, clipDuration?: number, speedMultiplier?: number) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const sendProgress = (stage: string, progress: number) => {
      win?.webContents.send('transcribe:progress', { stage, progress });
    };

    const speed = speedMultiplier || 1;
    // Source duration = timeline duration * speed (how much source material is covered)
    const srcDuration = (clipDuration != null && clipDuration > 0) ? clipDuration * speed : undefined;

    try {
      // Step 1: Extract audio as 16kHz mono WAV (only the clip's source range)
      sendProgress('Extracting audio...', 0.05);
      const wavPath = await extractAudioWav(filePath, sourceStart, srcDuration);

      // Step 2: Load Whisper model (cached after first download)
      sendProgress('Loading Whisper model...', 0.15);
      if (!whisperPipeline) {
        // Dynamic import for @xenova/transformers (ESM compatible)
        const { pipeline, env } = await Function('return import("@xenova/transformers")')();
        // Use default cache dir in app userData
        env.cacheDir = path.join(app.getPath('userData'), 'whisper-models');
        env.allowLocalModels = true;
        env.allowRemoteModels = true;
        whisperPipeline = await pipeline(
          'automatic-speech-recognition',
          'Xenova/whisper-base',
          { revision: 'main' }
        );
      }

      // Step 3: Read WAV as raw Float32Array (AudioContext not available in Node.js)
      sendProgress('Transcribing audio...', 0.35);
      const wavBuffer = await fsp.readFile(wavPath);
      // Parse WAV: skip 44-byte header, read 16-bit PCM samples, convert to float32
      const pcmData = new Int16Array(wavBuffer.buffer, wavBuffer.byteOffset + 44, (wavBuffer.byteLength - 44) / 2);
      const float32Data = new Float32Array(pcmData.length);
      for (let i = 0; i < pcmData.length; i++) {
        float32Data[i] = pcmData[i] / 32768;
      }

      const result = await whisperPipeline(float32Data, {
        return_timestamps: 'word',
        chunk_length_s: 30,
        stride_length_s: 5,
        language: 'en',
        task: 'transcribe',
        sampling_rate: 16000,
      });

      // Clean up temp WAV
      fsp.unlink(wavPath).catch(() => {});

      sendProgress('Processing results...', 0.85);

      // Step 4: Group words into short subtitle phrases (viral style: 3-5 words)
      interface WordChunk { text: string; timestamp: [number, number] }
      const words: WordChunk[] = (result.chunks || []).filter(
        (c: any) => c.timestamp && c.timestamp[0] != null && c.timestamp[1] != null
      );

      if (words.length === 0) {
        return { success: true, subtitles: [] };
      }

      // Group into short phrases
      const MAX_WORDS = 4;
      const MIN_GAP_S = 0.4; // split on pauses longer than this
      const subtitles: Array<{ text: string; startTime: number; endTime: number }> = [];
      let groupWords: WordChunk[] = [];

      for (let i = 0; i < words.length; i++) {
        const word = words[i];
        groupWords.push(word);

        const nextWord = words[i + 1];
        const isLastWord = i === words.length - 1;
        const endsWithPunctuation = /[.!?;,]$/.test(word.text.trim());
        const hasPause = nextWord && (nextWord.timestamp[0] - word.timestamp[1]) > MIN_GAP_S;
        const groupFull = groupWords.length >= MAX_WORDS;

        if (isLastWord || groupFull || endsWithPunctuation || hasPause) {
          const text = groupWords.map(w => w.text).join('').trim();
          if (text) {
            // Whisper timestamps are in source time (relative to extracted clip start).
            // Map to timeline time by dividing by speedMultiplier.
            subtitles.push({
              text,
              startTime: timelineOffset + groupWords[0].timestamp[0] / speed,
              endTime: timelineOffset + groupWords[groupWords.length - 1].timestamp[1] / speed,
            });
          }
          groupWords = [];
        }
      }

      sendProgress('Done!', 1.0);
      return { success: true, subtitles };
    } catch (err: any) {
      console.error('Transcription error:', err);
      return { success: false, error: err.message || String(err) };
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
