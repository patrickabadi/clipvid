import { MonitorPlay, Pause, Play, SkipBack, SkipForward, Volume2, VolumeX } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTimelineContext } from '../lib/TimelineContext';
import { Clip, Track, TransitionType } from '../lib/types';
import SubtitleOverlay from './SubtitleOverlay';

function getMediaUrl(filePath: string): string {
  if (window.electronAPI?.getFileUrl) {
    return window.electronAPI.getFileUrl(filePath);
  }
  return filePath;
}

const clipTimeFor = (clip: Clip, cursorPos: number) =>
  clip.sourceStart + (cursorPos - clip.startOffset) * clip.speedMultiplier;

const formatTimecode = (seconds: number) => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const f = Math.floor((seconds % 1) * 30);
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}:${f.toString().padStart(2, '0')}`;
};

/* ── Transition zone detection ── */

interface ActiveTransition {
  type: TransitionType;
  progress: number; // 0 → 1 across the full transition
  duration: number;
  cutPoint: number;
  outClip: Clip;    // the clip that is ending
  inClip: Clip;     // the clip that is starting (has the transition property)
}

function detectTransition(cursor: number, tracks: Track[]): ActiveTransition | null {
  for (const track of tracks) {
    if (track.type !== 'video' || !track.visible) continue;
    const sorted = [...track.clips].sort((a, b) => a.startOffset - b.startOffset);
    for (const clip of sorted) {
      if (!clip.transition) continue;
      const d = clip.transition.duration;
      const cutPoint = clip.startOffset;
      const zoneStart = cutPoint - d / 2;
      const zoneEnd = cutPoint + d / 2;
      if (cursor >= zoneStart && cursor < zoneEnd) {
        // Find the adjacent previous clip
        const prevClip = sorted.find(c =>
          c.id !== clip.id &&
          Math.abs((c.startOffset + c.duration) - cutPoint) < 0.05
        );
        if (!prevClip) continue; // no adjacent clip — skip
        return {
          type: clip.transition.type,
          progress: Math.max(0, Math.min(1, (cursor - zoneStart) / d)),
          duration: d,
          cutPoint,
          outClip: prevClip,
          inClip: clip,
        };
      }
    }
  }
  return null;
}

/** Clamp a source-time seek for a clip within its valid range */
function clampedSourceTime(clip: Clip, cursor: number): number {
  const raw = clip.sourceStart + (cursor - clip.startOffset) * clip.speedMultiplier;
  const srcStart = clip.sourceStart;
  const srcEnd = clip.sourceStart + clip.duration * clip.speedMultiplier;
  return Math.max(srcStart, Math.min(srcEnd - 0.01, raw));
}

/**
 * Apply transition visual effects to TWO video elements (outgoing + incoming)
 * plus an overlay div. Both videos should already be loaded and seeked.
 *
 * outEl = the outgoing clip video (bottom layer)
 * inEl  = the incoming clip video (top layer)
 */
function applyTransitionFx(
  trans: ActiveTransition | null,
  outEl: HTMLVideoElement | null,
  inEl: HTMLVideoElement | null,
  overlayEl: HTMLDivElement | null,
) {
  const reset = (el: HTMLVideoElement | null) => {
    if (!el) return;
    el.style.opacity = '1';
    el.style.clipPath = '';
    el.style.transform = '';
    el.style.filter = '';
    el.style.zIndex = '';
  };

  reset(outEl);
  reset(inEl);
  if (overlayEl) {
    overlayEl.style.opacity = '0';
    overlayEl.style.background = 'black';
  }

  // When no transition, hide the secondary video
  if (!trans) {
    if (inEl) inEl.style.opacity = '0';
    return;
  }

  if (!outEl || !inEl || !overlayEl) return;

  const p = trans.progress; // 0 → 1

  // Ensure incoming video is on top of outgoing
  outEl.style.zIndex = '1';
  inEl.style.zIndex = '2';

  switch (trans.type) {
    case 'fade': {
      // Dip to black: outgoing fades out, incoming fades in, black shows between
      outEl.style.opacity = String(Math.max(0, 1 - p * 2));
      inEl.style.opacity = String(Math.max(0, p * 2 - 1));
      break;
    }

    case 'flash': {
      // Flash to white: same timing as fade, white overlay peaks in the middle
      const peak = Math.sin(Math.PI * p);
      outEl.style.opacity = String(Math.max(0, 1 - p * 2));
      inEl.style.opacity = String(Math.max(0, p * 2 - 1));
      overlayEl.style.background = 'white';
      overlayEl.style.opacity = String(peak);
      break;
    }

    case 'dissolve': {
      // Cross-dissolve: outgoing fades out while incoming fades in simultaneously
      outEl.style.opacity = String(1 - p);
      inEl.style.opacity = String(p);
      break;
    }

    case 'wipe-left': {
      // Incoming clip is revealed from left to right, covering outgoing
      outEl.style.opacity = '1';
      inEl.style.opacity = '1';
      inEl.style.clipPath = `inset(0 ${(1 - p) * 100}% 0 0)`;
      break;
    }

    case 'wipe-right': {
      // Incoming clip is revealed from right to left
      outEl.style.opacity = '1';
      inEl.style.opacity = '1';
      inEl.style.clipPath = `inset(0 0 0 ${(1 - p) * 100}%)`;
      break;
    }

    case 'slide-left': {
      // Outgoing slides out left, incoming slides in from right
      outEl.style.opacity = '1';
      outEl.style.transform = `translateX(${-p * 100}%)`;
      inEl.style.opacity = '1';
      inEl.style.transform = `translateX(${(1 - p) * 100}%)`;
      break;
    }

    case 'slide-right': {
      // Outgoing slides out right, incoming slides in from left
      outEl.style.opacity = '1';
      outEl.style.transform = `translateX(${p * 100}%)`;
      inEl.style.opacity = '1';
      inEl.style.transform = `translateX(${-(1 - p) * 100}%)`;
      break;
    }

    case 'zoom': {
      // Outgoing zooms in + fades, incoming zooms out from large + appears
      const outScale = 1 + p * 2;
      const inScale = 1 + (1 - p) * 2;
      outEl.style.transform = `scale(${outScale})`;
      outEl.style.filter = `blur(${p * 8}px)`;
      outEl.style.opacity = String(1 - p);
      inEl.style.transform = `scale(${inScale})`;
      inEl.style.filter = `blur(${(1 - p) * 8}px)`;
      inEl.style.opacity = String(p);
      break;
    }

    case 'blur': {
      // Outgoing blurs + fades, incoming de-blurs + appears
      outEl.style.filter = `blur(${p * 20}px)`;
      outEl.style.opacity = String(1 - p);
      inEl.style.filter = `blur(${(1 - p) * 20}px)`;
      inEl.style.opacity = String(p);
      break;
    }
  }
}

const Player: React.FC = () => {
  const { state, togglePlayback, stopPlayback, skipBackward, skipForward, setCursorPosition } = useTimelineContext();
  const videoRef = useRef<HTMLVideoElement>(null);
  const videoBRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const transOverlayRef = useRef<HTMLDivElement>(null);
  const [muted, setMuted] = useState(false);
  const [aspectRatio, setAspectRatio] = useState<number | null>(null);

  /* ── always-fresh refs ── */
  const tracksRef = useRef(state.tracks);
  tracksRef.current = state.tracks;
  const isPlayingRef = useRef(state.isPlaying);
  isPlayingRef.current = state.isPlaying;
  const cursorRef = useRef(state.cursorPosition);
  cursorRef.current = state.cursorPosition;

  /* Track what file is loaded on each element (shared between scrub + playback) */
  const loadedVideoPath = useRef<string>('');
  const loadedVideoPathB = useRef<string>('');
  const loadedAudioPath = useRef<string>('');

  /*
   * Pending seek ref: stores the desired seek time so that when the video
   * finishes loading, a persistent handler can seek to the LATEST position
   * instead of a stale-closure value. This solves both the scrub-preview
   * and the play-from-position bugs.
   */
  const pendingVideoSeek = useRef<number | null>(null);
  const pendingVideoSeekB = useRef<number | null>(null);

  /** Search fresh tracks for a clip covering `pos`. */
  const findClipAt = useCallback((pos: number, type: 'video' | 'audio'): Clip | null => {
    for (const track of tracksRef.current) {
      if (track.type !== type) continue;
      if (type === 'video' && !track.visible) continue;
      if (type === 'audio' && track.muted) continue;
      for (const clip of track.clips) {
        if (pos >= clip.startOffset && pos < clip.startOffset + clip.duration) {
          return clip;
        }
      }
    }
    return null;
  }, []);

  /** True when there is a video clip under the playhead (for empty-state overlay). */
  const hasVideoAtCursor = useMemo((): boolean => {
    for (const track of state.tracks) {
      if (track.type !== 'video') continue;
      for (const clip of track.clips) {
        if (state.cursorPosition >= clip.startOffset &&
            state.cursorPosition < clip.startOffset + clip.duration) {
          return true;
        }
      }
    }
    return false;
  }, [state.tracks, state.cursorPosition]);

  // ════════════════════════════════════════════════════════════════
  //  DETECT ASPECT RATIO from the primary video element
  // ════════════════════════════════════════════════════════════════
  useEffect(() => {
    const vid = videoRef.current;
    if (!vid) return;
    const onMeta = () => {
      if (vid.videoWidth && vid.videoHeight) {
        setAspectRatio(vid.videoWidth / vid.videoHeight);
      }
    };
    vid.addEventListener('loadedmetadata', onMeta);
    return () => vid.removeEventListener('loadedmetadata', onMeta);
  }, []);

  // ════════════════════════════════════════════════════════════════
  //  PERSISTENT VIDEO HANDLER — fires on multiple video events.
  //  Reads from `pendingVideoSeek` ref so it ALWAYS seeks to the
  //  latest desired time, never a stale closure value.
  //  We listen to loadeddata, canplay, canplaythrough AND progress
  //  because the custom media:// protocol streams the full file and
  //  a seek may not be fulfillable until enough bytes arrive.
  // ════════════════════════════════════════════════════════════════
  useEffect(() => {
    const vid = videoRef.current;
    if (!vid) return;

    const applyPendingSeek = () => {
      const target = pendingVideoSeek.current;
      if (target === null) return;
      if (vid.readyState < 1) return; // need at least metadata
      vid.currentTime = target;
      // If we're playing, start the video element
      if (isPlayingRef.current) {
        vid.play().catch(() => {});
      }
    };

    // When a seek completes, clear the pending if it matches
    const onSeeked = () => {
      const target = pendingVideoSeek.current;
      if (target !== null && Math.abs(vid.currentTime - target) < 0.1) {
        pendingVideoSeek.current = null;
      }
    };

    vid.addEventListener('loadeddata', applyPendingSeek);
    vid.addEventListener('canplay', applyPendingSeek);
    vid.addEventListener('canplaythrough', applyPendingSeek);
    vid.addEventListener('progress', applyPendingSeek);
    vid.addEventListener('seeked', onSeeked);
    return () => {
      vid.removeEventListener('loadeddata', applyPendingSeek);
      vid.removeEventListener('canplay', applyPendingSeek);
      vid.removeEventListener('canplaythrough', applyPendingSeek);
      vid.removeEventListener('progress', applyPendingSeek);
      vid.removeEventListener('seeked', onSeeked);
    };
  }, []);

  // ════════════════════════════════════════════════════════════════
  //  PERSISTENT HANDLER FOR VIDEO B (transition secondary video)
  // ════════════════════════════════════════════════════════════════
  useEffect(() => {
    const vid = videoBRef.current;
    if (!vid) return;

    const applyPendingSeek = () => {
      const target = pendingVideoSeekB.current;
      if (target === null) return;
      if (vid.readyState < 1) return;
      vid.currentTime = target;
    };

    const onSeeked = () => {
      const target = pendingVideoSeekB.current;
      if (target !== null && Math.abs(vid.currentTime - target) < 0.1) {
        pendingVideoSeekB.current = null;
      }
    };

    vid.addEventListener('loadeddata', applyPendingSeek);
    vid.addEventListener('canplay', applyPendingSeek);
    vid.addEventListener('canplaythrough', applyPendingSeek);
    vid.addEventListener('progress', applyPendingSeek);
    vid.addEventListener('seeked', onSeeked);
    return () => {
      vid.removeEventListener('loadeddata', applyPendingSeek);
      vid.removeEventListener('canplay', applyPendingSeek);
      vid.removeEventListener('canplaythrough', applyPendingSeek);
      vid.removeEventListener('progress', applyPendingSeek);
      vid.removeEventListener('seeked', onSeeked);
    };
  }, []);

  // ════════════════════════════════════════════════════════════════
  //  SCRUB — when paused, seek video/audio to the cursor position.
  //  Manages both videoRef (primary) and videoBRef (secondary/transition).
  // ════════════════════════════════════════════════════════════════
  useEffect(() => {
    if (state.isPlaying) return;

    const vid = videoRef.current;
    const vidB = videoBRef.current;
    const aud = audioRef.current;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let pollTimerB: ReturnType<typeof setInterval> | null = null;

    // Detect transition at cursor position
    const trans = detectTransition(state.cursorPosition, state.tracks);

    if (trans && vid && vidB) {
      // ── TRANSITION SCRUB: load BOTH clips ──
      const outClip = trans.outClip;
      const inClip = trans.inClip;
      const outSeek = clampedSourceTime(outClip, state.cursorPosition);
      const inSeek = clampedSourceTime(inClip, state.cursorPosition);

      // Load outgoing clip on primary video
      pendingVideoSeek.current = outSeek;
      if (loadedVideoPath.current !== outClip.path) {
        loadedVideoPath.current = outClip.path;
        vid.src = getMediaUrl(outClip.path);
      } else if (vid.readyState >= 1) {
        vid.currentTime = outSeek;
      }
      pollTimer = setInterval(() => {
        const target = pendingVideoSeek.current;
        if (target === null) { clearInterval(pollTimer!); pollTimer = null; return; }
        if (vid.readyState >= 1) {
          vid.currentTime = target;
          if (Math.abs(vid.currentTime - target) < 0.1) {
            pendingVideoSeek.current = null;
            clearInterval(pollTimer!);
            pollTimer = null;
          }
        }
      }, 50);

      // Load incoming clip on secondary video
      pendingVideoSeekB.current = inSeek;
      if (loadedVideoPathB.current !== inClip.path) {
        loadedVideoPathB.current = inClip.path;
        vidB.src = getMediaUrl(inClip.path);
      } else if (vidB.readyState >= 1) {
        vidB.currentTime = inSeek;
      }
      pollTimerB = setInterval(() => {
        const target = pendingVideoSeekB.current;
        if (target === null) { clearInterval(pollTimerB!); pollTimerB = null; return; }
        if (vidB.readyState >= 1) {
          vidB.currentTime = target;
          if (Math.abs(vidB.currentTime - target) < 0.1) {
            pendingVideoSeekB.current = null;
            clearInterval(pollTimerB!);
            pollTimerB = null;
          }
        }
      }, 50);

      // Apply transition FX: outgoing = vid (primary), incoming = vidB (secondary)
      applyTransitionFx(trans, vid, vidB, transOverlayRef.current);
    } else {
      // ── NORMAL SCRUB: single clip ──
      const vc = findClipAt(state.cursorPosition, 'video');
      if (vid) {
        if (vc) {
          const seekTime = Math.max(0, clipTimeFor(vc, state.cursorPosition));
          pendingVideoSeek.current = seekTime;
          if (loadedVideoPath.current !== vc.path) {
            loadedVideoPath.current = vc.path;
            vid.src = getMediaUrl(vc.path);
          } else if (vid.readyState >= 1) {
            vid.currentTime = seekTime;
          }
          pollTimer = setInterval(() => {
            const target = pendingVideoSeek.current;
            if (target === null) { clearInterval(pollTimer!); pollTimer = null; return; }
            if (vid.readyState >= 1) {
              vid.currentTime = target;
              if (Math.abs(vid.currentTime - target) < 0.1) {
                pendingVideoSeek.current = null;
                clearInterval(pollTimer!);
                pollTimer = null;
              }
            }
          }, 50);
        } else if (loadedVideoPath.current) {
          vid.pause();
          vid.removeAttribute('src');
          vid.load();
          loadedVideoPath.current = '';
          pendingVideoSeek.current = null;
        }
      }

      // Hide secondary video when not in transition
      applyTransitionFx(null, vid, vidB, transOverlayRef.current);
    }

    // ── Audio scrub ──
    const ac = findClipAt(state.cursorPosition, 'audio');
    if (aud) {
      if (ac) {
        const seekTime = Math.max(0, clipTimeFor(ac, state.cursorPosition));
        if (loadedAudioPath.current !== ac.path) {
          loadedAudioPath.current = ac.path;
          aud.src = getMediaUrl(ac.path);
        }
        if (aud.readyState >= 1) aud.currentTime = seekTime;
      } else if (loadedAudioPath.current) {
        aud.pause();
        aud.removeAttribute('src');
        aud.load();
        loadedAudioPath.current = '';
      }
    }

    return () => {
      if (pollTimer) clearInterval(pollTimer);
      if (pollTimerB) clearInterval(pollTimerB);
    };
  }, [state.cursorPosition, state.isPlaying, state.tracks, findClipAt]);

  // ════════════════════════════════════════════════════════════════
  //  MASTER PLAYBACK LOOP
  //  Single RAF: loads clips, syncs cursor from video currentTime,
  //  handles transitions between clips, gaps, and end-of-timeline.
  //  Reads cursor from cursorRef (always fresh) so it always starts
  //  from the real playhead position.
  // ════════════════════════════════════════════════════════════════
  useEffect(() => {
    if (!state.isPlaying) return;

    const vid = videoRef.current;
    const aud = audioRef.current;
    // Read cursor from ref so it's always the latest value
    // (even if StrictMode double-fires this effect)
    let cursor = cursorRef.current;
    let lastWall = performance.now();
    let raf: number;
    let cancelled = false;

    /* video state */
    let vidClipId: string | null = null;
    let stalledSince: number | null = null;
    const STALL_MS = 500;

    /* audio state */
    let audClipId: string | null = null;

    const getMaxEnd = (): number => {
      let m = 0;
      for (const t of tracksRef.current)
        for (const c of t.clips) m = Math.max(m, c.startOffset + c.duration);
      return m;
    };

    /* ── video helpers ── */
    const loadVid = (clip: Clip) => {
      if (!vid) return;
      vidClipId = clip.id;
      vid.volume = Math.max(0, Math.min(1, clip.volume));
      vid.playbackRate = clip.speedMultiplier;
      const seekTime = Math.max(0, clipTimeFor(clip, cursor));

      if (loadedVideoPath.current === clip.path && vid.readyState >= 2) {
        // Same file, already buffered — fast seek + play
        pendingVideoSeek.current = null;
        vid.currentTime = seekTime;
        vid.play().catch(() => {});
        stalledSince = null;
      } else {
        // Different file or not ready yet — load & store pending seek
        if (loadedVideoPath.current !== clip.path) {
          loadedVideoPath.current = clip.path;
          vid.src = getMediaUrl(clip.path);
        }
        // The persistent loadeddata/canplay handler will seek + play
        pendingVideoSeek.current = seekTime;
        stalledSince = performance.now();
      }
    };

    const unloadVid = () => {
      if (!vid) return;
      vid.pause();
      vidClipId = null;
      stalledSince = null;
      pendingVideoSeek.current = null;
    };

    /* ── audio helpers ── */
    const loadAud = (clip: Clip) => {
      if (!aud) return;
      audClipId = clip.id;
      aud.volume = Math.max(0, Math.min(1, clip.volume));
      aud.playbackRate = clip.speedMultiplier;
      const seekTime = Math.max(0, clipTimeFor(clip, cursor));
      if (loadedAudioPath.current !== clip.path) {
        loadedAudioPath.current = clip.path;
        aud.src = getMediaUrl(clip.path);
      }
      if (aud.readyState >= 2) {
        aud.currentTime = seekTime;
        aud.play().catch(() => {});
      } else {
        aud.currentTime = seekTime;
        aud.play().catch(() => {});
      }
    };

    const unloadAud = () => {
      if (!aud) return;
      aud.pause();
      audClipId = null;
    };

    /* ── early bail: cursor already past all content ── */
    const maxEnd0 = getMaxEnd();
    if (maxEnd0 === 0 || cursor >= maxEnd0) {
      stopPlayback();
      return;
    }

    /* ── initialise media at current position ── */
    const initV = findClipAt(cursor, 'video');
    if (initV) loadVid(initV);
    const initA = findClipAt(cursor, 'audio');
    if (initA) loadAud(initA);

    /* ── per-frame tick ── */
    const tick = (now: number) => {
      if (cancelled) return;
      const dt = Math.min((now - lastWall) / 1000, 0.1);
      lastWall = now;

      /* ─── VIDEO + TRANSITION ─── */
      const vidB = videoBRef.current;
      const trans = detectTransition(cursor, tracksRef.current);

      if (trans && vid && vidB) {
        /* ── Transition zone: dual-video playback ── */

        // Keep outgoing clip on videoRef
        if (vidClipId !== trans.outClip.id) loadVid(trans.outClip);

        // Load incoming clip on videoBRef
        if (loadedVideoPathB.current !== trans.inClip.path) {
          loadedVideoPathB.current = trans.inClip.path;
          vidB.src = getMediaUrl(trans.inClip.path);
          pendingVideoSeekB.current = clampedSourceTime(trans.inClip, cursor);
        }
        vidB.playbackRate = trans.inClip.speedMultiplier;
        if (vidB.readyState >= 2 && vidB.paused) {
          vidB.play().catch(() => {});
        }

        // Cursor advancement
        const playing = !vid.paused && vid.readyState >= 2;
        if (playing && cursor < trans.cutPoint) {
          stalledSince = null;
          pendingVideoSeek.current = null;
          cursor = trans.outClip.startOffset +
            (vid.currentTime - trans.outClip.sourceStart) / trans.outClip.speedMultiplier;
        } else {
          cursor += dt;
        }

        applyTransitionFx(trans, vid, vidB, transOverlayRef.current);

      } else {
        /* ── Normal: single-video playback ── */

        // Clean up videoBRef when leaving transition zone
        if (vidB && loadedVideoPathB.current) {
          vidB.pause();
          loadedVideoPathB.current = '';
          pendingVideoSeekB.current = null;
        }
        applyTransitionFx(null, vid, vidB, transOverlayRef.current);

        const vc = findClipAt(cursor, 'video');

        if (vc) {
          if (vidClipId !== vc.id) loadVid(vc);

          // Check end-of-clip FIRST — before playing/stall logic —
          // so that a video which reached its natural end (vid.ended)
          // advances to the next clip instead of being restarted.
          const srcEnd = vc.sourceStart + vc.duration * vc.speedMultiplier;
          const clipDone = vid != null && vid.readyState >= 1 &&
            (vid.currentTime >= srcEnd - 0.05 || vid.ended);

          if (clipDone) {
            cursor = vc.startOffset + vc.duration;
            unloadVid();
            const next = findClipAt(cursor, 'video');
            if (next) loadVid(next);
          } else {
            const playing = vid != null && !vid.paused && vid.readyState >= 2;

            if (playing) {
              stalledSince = null;
              pendingVideoSeek.current = null;
              cursor = vc.startOffset + (vid!.currentTime - vc.sourceStart) / vc.speedMultiplier;
            } else {
              if (vid && vid.readyState >= 2 && vid.paused && pendingVideoSeek.current === null) {
                vid.play().catch(() => {});
              }
              if (!stalledSince) stalledSince = performance.now();
              if (now - stalledSince > STALL_MS) {
                cursor += dt;
                if (cursor >= vc.startOffset + vc.duration) {
                  cursor = vc.startOffset + vc.duration;
                  unloadVid();
                }
              }
            }
          }
        } else {
          if (vidClipId) unloadVid();
          cursor += dt;
        }
      }

      /* ─── AUDIO ─── */
      const ac = findClipAt(cursor, 'audio');
      if (ac) {
        if (audClipId !== ac.id) loadAud(ac);
        // Keep volume & speed synced in case user adjusts during playback
        if (aud) {
          aud.volume = Math.max(0, Math.min(1, ac.volume));
          aud.playbackRate = ac.speedMultiplier;
        }
      } else if (audClipId) {
        unloadAud();
      }

      /* ─── SYNC VIDEO VOLUME & SPEED ─── */
      if (vid) {
        const vc = findClipAt(cursor, 'video');
        if (vc) {
          vid.volume = Math.max(0, Math.min(1, vc.volume));
          vid.playbackRate = vc.speedMultiplier;
        }
      }

      /* ─── END OF TIMELINE ─── */
      const maxEnd = getMaxEnd();
      if (maxEnd > 0 && cursor >= maxEnd) {
        cursor = maxEnd;
        setCursorPosition(cursor);
        stopPlayback();
        return;
      }

      setCursorPosition(cursor);
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      vid?.pause();
      videoBRef.current?.pause();
      aud?.pause();
      applyTransitionFx(null, vid, videoBRef.current, transOverlayRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.isPlaying]);

  // ════════════════════════════════════════════════════════════════
  //  MUTE SYNC
  // ════════════════════════════════════════════════════════════════
  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = muted;
    if (videoBRef.current) videoBRef.current.muted = muted;
    if (audioRef.current) audioRef.current.muted = muted;
  }, [muted]);

  // ════════════════════════════════════════════════════════════════
  //  KEYBOARD SHORTCUTS
  // ════════════════════════════════════════════════════════════════
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.code === 'Space') { e.preventDefault(); togglePlayback(); }
      else if (e.key === 'ArrowLeft') skipBackward();
      else if (e.key === 'ArrowRight') skipForward();
      else if (e.key === 'm' || e.key === 'M') setMuted(m => !m);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlayback, skipBackward, skipForward]);

  return (
    <div className="player-preview">
      <div className="player-header">
        <h2>
          <MonitorPlay size={16} />
          Preview
        </h2>
      </div>
      <div className="video-container" style={aspectRatio ? { aspectRatio: String(aspectRatio) } : undefined}>
        <video
          ref={videoRef}
          className="player-video"
          playsInline
          preload="auto"
          muted={muted}
        />
        <video
          ref={videoBRef}
          className="player-video player-video-b"
          playsInline
          preload="auto"
          muted={muted}
        />
        <audio ref={audioRef} preload="auto" muted={muted} />

        {/* Transition overlay (fade/flash/etc) */}
        <div ref={transOverlayRef} className="player-transition-overlay" />

        {/* Subtitle overlay */}
        <SubtitleOverlay />

        {!hasVideoAtCursor && (
          <div className="video-empty-state">
            <MonitorPlay size={48} opacity={0.15} />
            <span>No video at playhead</span>
          </div>
        )}
      </div>

      <div className="player-controls-bar">
        <div className="player-controls glass-panel">
          <button className="player-btn" onClick={skipBackward} title="Skip Back 5s (Left Arrow)">
            <SkipBack size={18} />
          </button>
          <button className="player-btn play" onClick={togglePlayback} title="Play/Pause (Space)">
            {state.isPlaying
              ? <Pause size={18} fill="currentColor" />
              : <Play size={18} fill="currentColor" style={{ marginLeft: '2px' }} />}
          </button>
          <button className="player-btn" onClick={skipForward} title="Skip Forward 5s (Right Arrow)">
            <SkipForward size={18} />
          </button>
          <div className="player-divider" />
          <button className="player-btn" onClick={() => setMuted(m => !m)} title="Mute/Unmute (M)">
            {muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
          </button>
          <div className="player-divider" />
          <div className="timecode-display">
            {formatTimecode(state.cursorPosition)}
          </div>
        </div>
      </div>
    </div>
  );
};

export default Player;
