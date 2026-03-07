import { app, BrowserWindow, dialog, ipcMain, protocol } from 'electron';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import ffmpeg from 'fluent-ffmpeg';
import { createReadStream, promises as fsp } from 'fs';
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
            .duration(srcDuration);

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
        let runningDuration = segDurations[0];

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
            runningDuration = offset + segDurations[i + 1];
          } else {
            // Hard cut: minimal 1-frame crossfade at 30fps
            const minD = 1 / 30;
            const offset = Math.max(0, runningDuration - minD);
            filters.push(
              `[${lastV}][${i + 1}:v]xfade=transition=fade:duration=${minD.toFixed(4)}:offset=${offset.toFixed(4)}[${outV}]`
            );
            runningDuration = offset + segDurations[i + 1];
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
            .on('end', () => resolve())
            .on('error', (err: any) => reject(err));
        });
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
              .duration(srcDuration)
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
