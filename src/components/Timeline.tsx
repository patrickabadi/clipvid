import {
    Copy, Eye, EyeOff, Film, Lock, Magnet, Maximize2, Music, Plus,
    Scissors, SkipBack, SkipForward, Sparkles, Trash2, Type, Unlock, Volume2, VolumeX,
    ZoomIn, ZoomOut,
} from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTimelineContext } from '../lib/TimelineContext';
import { Clip, SubtitleAnimation, SubtitleFontFamily, TransitionType } from '../lib/types';

const PX_PER_SEC_BASE = 50;
const TRACK_HEADER_W = 150;
const SNAP_PX = 10;
const MIN_DUR = 0.05;

/* Palette of visually distinct clip colours, picked per media source */
const CLIP_PALETTE = [
  '#e0465a', '#d46b2e', '#c9a830', '#5cb85c', '#3ba99c',
  '#4a90d9', '#7e57c2', '#c04da8', '#8d6e63', '#5c7cfa',
];
function clipColorForMedia(mediaId: string): string {
  let h = 0;
  for (let i = 0; i < mediaId.length; i++) h = ((h << 5) - h + mediaId.charCodeAt(i)) | 0;
  return CLIP_PALETTE[Math.abs(h) % CLIP_PALETTE.length];
}
function shortClipName(name: string): string {
  let n = name.replace(/\.[^.]+$/, '');
  n = n.replace(/_?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '');
  n = n.replace(/[_-]+$/, '');
  return n || name;
}
function fmtDur(sec: number) {
  if (sec < 60) return sec.toFixed(1) + 's';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
function fmtTime(sec: number) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

interface DragInfo {
  type: 'move' | 'trim-left' | 'trim-right';
  clipId: string;
  trackId: string;
  startX: number;
  startY: number;
  origStart: number;
  origDuration: number;
  origSourceStart: number;
  origSpeed: number;
  mediaDuration: number; // total source media duration for speed-stretch
}

/* Trim feedback tooltip state */
interface TrimFeedback {
  clipId: string;
  side: 'left' | 'right';
  label: string;
}

interface ContextMenu {
  x: number;
  y: number;
  clipId: string;
  trackId: string;
}

const Timeline: React.FC = () => {
  const {
    state, addClip, updateClip, moveClipToTrack, setCursorPosition, setScale,
    selectClip, removeClip, splitClip, duplicateClip, toggleSnap, addTrack,
    toggleTrackMute, toggleTrackLock, toggleTrackVisible, fitToTimeline,
    jumpToStart, jumpToEnd, pushUndo,
    selectTransition, addTransition, removeTransition,
    selectSubtitle, updateSubtitle, updateSubtitleStyle, removeSubtitle,
  } = useTimelineContext();

  const [mediaDropTarget, setMediaDropTarget] = useState<string | null>(null);
  const [subPopupId, setSubPopupId] = useState<string | null>(null);
  const subPopupRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragInfo | null>(null);
  const [snapLine, setSnapLine] = useState<number | null>(null);
  const [ctxMenu, setCtxMenu] = useState<ContextMenu | null>(null);
  const [trimFeedback, setTrimFeedback] = useState<TrimFeedback | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragTrackRef = useRef<string | null>(null);

  const pxPerSec = state.scale * PX_PER_SEC_BASE;
  const snapThresh = SNAP_PX / pxPerSec;

  // Refs so the drag effect doesn't re-run when state changes mid-drag
  const pxPerSecRef = useRef(pxPerSec);
  pxPerSecRef.current = pxPerSec;

  const mediaLibRef = useRef(state.mediaLibrary);
  mediaLibRef.current = state.mediaLibrary;

  const totalWidthPx = useMemo(() => {
    let maxEnd = 300;
    state.tracks.forEach(t => t.clips.forEach(c => {
      maxEnd = Math.max(maxEnd, c.startOffset + c.duration + 30);
    }));
    return maxEnd * pxPerSec + TRACK_HEADER_W;
  }, [state.tracks, pxPerSec]);

  /* ──────── Snap logic ──────── */

  const getSnapTargets = useCallback((excludeId?: string): number[] => {
    const pts: number[] = [state.cursorPosition, 0];
    for (const t of state.tracks) {
      for (const c of t.clips) {
        if (c.id !== excludeId) {
          pts.push(c.startOffset);
          pts.push(c.startOffset + c.duration);
        }
      }
    }
    return pts;
  }, [state.tracks, state.cursorPosition]);

  const findSnap = useCallback((candidates: number[], excludeId: string) => {
    if (!state.snapEnabled) return { delta: 0, pos: null as number | null };
    const targets = getSnapTargets(excludeId);
    let best = Infinity;
    let snapPos: number | null = null;
    for (const c of candidates) {
      for (const t of targets) {
        const d = t - c;
        if (Math.abs(d) < Math.abs(best) && Math.abs(d) <= snapThresh) {
          best = d;
          snapPos = t;
        }
      }
    }
    return snapPos !== null ? { delta: best, pos: snapPos } : { delta: 0, pos: null as number | null };
  }, [state.snapEnabled, getSnapTargets, snapThresh]);

  const findSnapRef = useRef(findSnap);
  findSnapRef.current = findSnap;

  /* ──────── Clip dragging (move / trim) ──────── */

  const onClipMouseDown = useCallback((e: React.MouseEvent, clip: Clip, trackId: string) => {
    e.stopPropagation();
    e.preventDefault();
    setCtxMenu(null);
    selectClip(clip.id);

    const rect = e.currentTarget.getBoundingClientRect();
    const localX = e.clientX - rect.left;
    const w = rect.width;
    const HANDLE = 8;

    let type: DragInfo['type'] = 'move';
    if (localX <= HANDLE) type = 'trim-left';
    else if (localX >= w - HANDLE) type = 'trim-right';

    pushUndo();

    const media = mediaLibRef.current.find(m => m.id === clip.mediaId);
    const mediaDuration = media?.duration ?? Infinity;

    dragTrackRef.current = trackId;
    setDrag({
      type, clipId: clip.id, trackId, startX: e.clientX, startY: e.clientY,
      origStart: clip.startOffset, origDuration: clip.duration, origSourceStart: clip.sourceStart,
      origSpeed: clip.speedMultiplier, mediaDuration,
    });
  }, [selectClip, pushUndo, setCursorPosition, pxPerSec]);

  useEffect(() => {
    if (!drag) return;

    const onMove = (e: MouseEvent) => {
      const pps = pxPerSecRef.current;
      const snap = findSnapRef.current;
      const dt = (e.clientX - drag.startX) / pps;

      if (drag.type === 'move') {
        const raw = Math.max(0, drag.origStart + dt);
        const s = snap([raw, raw + drag.origDuration], drag.clipId);
        setSnapLine(s.pos);
        const newOffset = Math.max(0, raw + s.delta);

        // Cross-track detection
        const currentTrackId = dragTrackRef.current || drag.trackId;
        let movedTrack = false;
        const rows = scrollRef.current?.querySelectorAll('[data-track-id]');
        if (rows) {
          for (const row of Array.from(rows)) {
            const rect = row.getBoundingClientRect();
            if (e.clientY >= rect.top && e.clientY < rect.bottom) {
              const targetId = (row as HTMLElement).dataset.trackId;
              if (targetId && targetId !== currentTrackId) {
                moveClipToTrack(currentTrackId, drag.clipId, targetId, newOffset);
                dragTrackRef.current = targetId;
                movedTrack = true;
              }
              break;
            }
          }
        }
        if (!movedTrack) {
          updateClip(currentTrackId, drag.clipId, { startOffset: newOffset });
        }
      } else if (drag.type === 'trim-left') {
        const maxS = drag.origStart + drag.origDuration - MIN_DUR;
        const rawS = Math.max(0, Math.min(maxS, drag.origStart + dt));
        const s = snap([rawS], drag.clipId);
        const finalS = Math.max(0, Math.min(maxS, rawS + s.delta));
        const diff = finalS - drag.origStart; // negative when extending left
        setSnapLine(s.pos);

        const newDuration = drag.origDuration - diff;
        const candidateSourceStart = drag.origSourceStart + diff * drag.origSpeed;

        if (candidateSourceStart >= 0) {
          // Normal trim — there's source material to reveal
          updateClip(drag.trackId, drag.clipId, {
            startOffset: finalS,
            duration: newDuration,
            sourceStart: candidateSourceStart,
          });
          setTrimFeedback({ clipId: drag.clipId, side: 'left', label: `In: ${fmtTime(candidateSourceStart)}` });
        } else {
          // Stretching beyond source start — slow down to fill
          const availableSource = drag.mediaDuration;
          const newSpeed = availableSource / newDuration;
          updateClip(drag.trackId, drag.clipId, {
            startOffset: finalS,
            duration: newDuration,
            sourceStart: 0,
            speedMultiplier: newSpeed,
          });
          const speedPct = Math.round(newSpeed * 100);
          setTrimFeedback({ clipId: drag.clipId, side: 'left', label: `${speedPct}% speed` });
        }
      } else {
        const rawD = Math.max(MIN_DUR, drag.origDuration + dt);
        const end = drag.origStart + rawD;
        const s = snap([end], drag.clipId);
        const finalD = Math.max(MIN_DUR, rawD + s.delta);
        setSnapLine(s.pos);

        // How much source material is available from sourceStart
        const availableSource = drag.mediaDuration - drag.origSourceStart;
        // Source needed at original speed
        const sourceNeeded = finalD * drag.origSpeed;

        let newSpeed = drag.origSpeed;
        if (sourceNeeded > availableSource && availableSource > 0) {
          // Stretch: slow down so available source fills the new duration
          newSpeed = availableSource / finalD;
        }

        const outPoint = drag.origSourceStart + finalD * newSpeed;
        updateClip(drag.trackId, drag.clipId, { duration: finalD, speedMultiplier: newSpeed });
        const speedPct = Math.round(newSpeed * 100);
        setTrimFeedback({ clipId: drag.clipId, side: 'right', label: newSpeed !== drag.origSpeed ? `${speedPct}% speed` : `Out: ${fmtTime(outPoint)}` });
      }
    };

    const onUp = () => { dragTrackRef.current = null; setDrag(null); setSnapLine(null); setTrimFeedback(null); };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [drag, updateClip, moveClipToTrack]);

  /* ──────── Context menu ──────── */

  const onClipContextMenu = (e: React.MouseEvent, clip: Clip, trackId: string) => {
    e.preventDefault();
    e.stopPropagation();
    selectClip(clip.id);
    setCtxMenu({ x: e.clientX, y: e.clientY, clipId: clip.id, trackId });
  };

  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    document.addEventListener('click', close);
    document.addEventListener('contextmenu', close);
    return () => { document.removeEventListener('click', close); document.removeEventListener('contextmenu', close); };
  }, [ctxMenu]);

  // Close subtitle popup on outside click
  useEffect(() => {
    if (!subPopupId) return;
    const close = (e: MouseEvent) => {
      if (subPopupRef.current && !subPopupRef.current.contains(e.target as Node)) {
        setSubPopupId(null);
      }
    };
    // Delay to avoid closing on the click that opened it
    const timer = setTimeout(() => document.addEventListener('mousedown', close), 0);
    return () => { clearTimeout(timer); document.removeEventListener('mousedown', close); };
  }, [subPopupId]);

  /* ──────── Media drop from bin ──────── */

  const onMediaDrop = (e: React.DragEvent, trackId: string) => {
    e.preventDefault();
    setMediaDropTarget(null);

    // Handle transition drop
    const transType = e.dataTransfer.getData('transition-type') as TransitionType;
    if (transType) {
      // Find the closest clip boundary to the drop position
      const content = (e.currentTarget as HTMLElement).querySelector('.track-content');
      if (!content) return;
      const rect = content.getBoundingClientRect();
      const dropTime = Math.max(0, (e.clientX - rect.left) / pxPerSec);
      const track = state.tracks.find(t => t.id === trackId);
      if (!track) return;
      const sorted = [...track.clips].sort((a, b) => a.startOffset - b.startOffset);
      // Find the clip whose start is closest to the drop and has an adjacent previous clip
      let bestClip: Clip | null = null;
      let bestDist = Infinity;
      for (let i = 1; i < sorted.length; i++) {
        const curr = sorted[i];
        const prev = sorted[i - 1];
        if (Math.abs((prev.startOffset + prev.duration) - curr.startOffset) < 0.05 && !curr.transition) {
          const dist = Math.abs(dropTime - curr.startOffset);
          if (dist < bestDist) { bestDist = dist; bestClip = curr; }
        }
      }
      if (bestClip) {
        addTransition(trackId, bestClip.id, { type: transType, duration: 0.5 });
      }
      return;
    }

    const mediaId = e.dataTransfer.getData('source-media-id');
    if (!mediaId) return;
    const media = state.mediaLibrary.find(m => m.id === mediaId);
    if (!media) return;

    const content = (e.currentTarget as HTMLElement).querySelector('.track-content');
    if (!content) return;
    const rect = content.getBoundingClientRect();
    let dropTime = Math.max(0, (e.clientX - rect.left) / pxPerSec);

    if (state.snapEnabled) {
      const targets = getSnapTargets();
      for (const t of targets) {
        if (Math.abs(t - dropTime) <= snapThresh) { dropTime = t; break; }
        if (Math.abs(t - (dropTime + media.duration)) <= snapThresh) { dropTime = t - media.duration; break; }
      }
    }

    const newClip: Clip = {
      id: Math.random().toString(36).substr(2, 12),
      mediaId: media.id, trackId, type: media.type,
      startOffset: Math.max(0, dropTime), duration: media.duration, sourceStart: 0,
      speedMultiplier: 1.0, volume: 1.0, name: media.name, path: media.path,
    };
    addClip(trackId, newClip);
    selectClip(newClip.id);
  };

  /* ──────── Playhead click — ruler only ──────── */

  const onRulerClick = (e: React.MouseEvent) => {
    if (drag) return;
    if (!scrollRef.current) return;
    const rect = scrollRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left + scrollRef.current.scrollLeft - TRACK_HEADER_W;
    if (x >= 0) setCursorPosition(x / pxPerSec);
  };

  const onTrackAreaClick = (e: React.MouseEvent) => {
    // Deselect clip/transition when clicking empty track area (not on a clip)
    if (drag) return;
    const tgt = e.target as HTMLElement;
    if (tgt.closest('.timeline-clip') || tgt.closest('.track-header') || tgt.closest('.timeline-transition-zone') || tgt.closest('.transition-add-hotspot')) return;
    selectClip(null);
    selectTransition(null);
  };

  /* ──────── Keyboard shortcuts ──────── */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        // Delete selected transition
        if (state.selectedTransitionClipId) {
          for (const t of state.tracks) {
            if (t.clips.find(c => c.id === state.selectedTransitionClipId)) {
              removeTransition(t.id, state.selectedTransitionClipId);
              break;
            }
          }
          return;
        }
        if (state.selectedClipId) {
          for (const t of state.tracks) {
            if (t.clips.find(c => c.id === state.selectedClipId)) {
              removeClip(t.id, state.selectedClipId);
              break;
            }
          }
        }
      } else if ((e.key === 's' || e.key === 'S') && !e.ctrlKey && !e.metaKey) {
        if (state.selectedClipId) {
          for (const t of state.tracks) {
            const c = t.clips.find(c => c.id === state.selectedClipId);
            if (c && state.cursorPosition > c.startOffset && state.cursorPosition < c.startOffset + c.duration) {
              splitClip(t.id, c.id, state.cursorPosition);
              break;
            }
          }
        }
      } else if (e.key === 'n' || e.key === 'N') {
        if (!e.ctrlKey && !e.metaKey) toggleSnap();
      } else if (e.key === 'Escape') {
        selectClip(null);
        selectTransition(null);
        setCtxMenu(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state.selectedClipId, state.selectedTransitionClipId, state.tracks, state.cursorPosition, removeClip, removeTransition, splitClip, toggleSnap, selectClip, selectTransition]);

  /* ──────── Scroll & Zoom ──────── */

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        // Ctrl+scroll = zoom
        e.preventDefault();
        const d = e.deltaY > 0 ? -0.15 : 0.15;
        setScale(Math.max(0.1, Math.min(10, state.scale + d)));
      } else if (e.shiftKey || Math.abs(e.deltaX) > 0) {
        // Shift+scroll or horizontal trackpad = horizontal scroll (default)
      } else {
        // Plain scroll = horizontal scroll
        e.preventDefault();
        el.scrollLeft += e.deltaY;
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [state.scale, setScale]);

  /* ──────── Ruler ticks ──────── */

  const rulerTicks = useMemo(() => {
    const maxSec = Math.ceil(totalWidthPx / pxPerSec);
    let interval: number;
    if (pxPerSec >= 100) interval = 1;
    else if (pxPerSec >= 40) interval = 5;
    else if (pxPerSec >= 15) interval = 10;
    else interval = 30;

    const ticks: JSX.Element[] = [];
    for (let i = 0; i <= maxSec; i += interval) {
      const major = i % (interval * 2) === 0 || interval <= 1;
      ticks.push(
        <div key={i} className={`tick-mark ${major ? 'major' : ''}`} style={{ left: i * pxPerSec }}>
          {major && <span className="tick-time">{fmtTime(i)}</span>}
        </div>
      );
    }
    return ticks;
  }, [totalWidthPx, pxPerSec]);

  /* ──────── Toolbar actions ──────── */

  const deleteSelected = () => {
    if (!state.selectedClipId) return;
    for (const t of state.tracks) {
      if (t.clips.find(c => c.id === state.selectedClipId)) { removeClip(t.id, state.selectedClipId); return; }
    }
  };

  const splitAtPlayhead = () => {
    if (!state.selectedClipId) return;
    for (const t of state.tracks) {
      const c = t.clips.find(c => c.id === state.selectedClipId);
      if (c && state.cursorPosition > c.startOffset && state.cursorPosition < c.startOffset + c.duration) {
        splitClip(t.id, c.id, state.cursorPosition);
        return;
      }
    }
  };

  const handleFit = () => {
    if (scrollRef.current) fitToTimeline(scrollRef.current.clientWidth);
  };

  const playheadLeft = state.cursorPosition * pxPerSec + TRACK_HEADER_W;

  /* ──────── Render ──────── */

  return (
    <footer
      className="app-timeline"
      style={drag ? { cursor: drag.type === 'move' ? 'grabbing' : 'ew-resize' } : undefined}
    >
      {/* Toolbar */}
      <div className="timeline-toolbar">
        <div className="timeline-tools-left">
          <button className="tool-btn" onClick={jumpToStart} title="Jump to Start">
            <SkipBack size={14} />
          </button>
          <button className="tool-btn" onClick={jumpToEnd} title="Jump to End">
            <SkipForward size={14} />
          </button>
          <div className="tool-divider" />
          <button
            className={`tool-btn ${state.snapEnabled ? 'active' : ''}`}
            onClick={toggleSnap}
            title="Toggle Snap (N)"
          >
            <Magnet size={14} />
          </button>
          <button className="tool-btn" onClick={splitAtPlayhead} title="Split at Playhead (S)">
            <Scissors size={14} />
          </button>
          <button className="tool-btn" onClick={deleteSelected} title="Delete Selected (Del)">
            <Trash2 size={14} />
          </button>
        </div>
        <div className="timeline-tools-right">
          <div className="zoom-controls">
            <button className="tool-btn" onClick={() => setScale(Math.max(0.1, state.scale - 0.25))} title="Zoom Out">
              <ZoomOut size={14} />
            </button>
            <span className="zoom-label">{Math.round(state.scale * 100)}%</span>
            <button className="tool-btn" onClick={() => setScale(Math.min(10, state.scale + 0.25))} title="Zoom In">
              <ZoomIn size={14} />
            </button>
          </div>
          <button className="tool-btn" onClick={handleFit} title="Fit to Timeline">
            <Maximize2 size={14} />
          </button>
          <div className="tool-divider" />
          <button className="tool-btn add-track-btn" onClick={() => addTrack('video')} title="Add Video Track">
            <Plus size={11} /><Film size={12} />
          </button>
          <button className="tool-btn add-track-btn" onClick={() => addTrack('audio')} title="Add Audio Track">
            <Plus size={11} /><Music size={12} />
          </button>
        </div>
      </div>

      {/* Scrollable timeline area */}
      <div className="timeline-scroll-area" ref={scrollRef} onClick={onTrackAreaClick}>
        <div className="timeline-content" style={{ minWidth: totalWidthPx }}>

          {/* Ruler — click here to move playhead */}
          <div className="timeline-ruler" style={{ minWidth: totalWidthPx }} onClick={onRulerClick}>
            <div className="ruler-header" />
            <div className="ruler-ticks">{rulerTicks}</div>
          </div>

          {/* Tracks */}
          {state.tracks.map(track => (
            <div
              key={track.id}
              data-track-id={track.id}
              className={`track-row ${mediaDropTarget === track.id ? 'drop-highlight' : ''} ${track.muted ? 'track-muted' : ''}`}
              style={{ minWidth: totalWidthPx }}
              onDragOver={e => { e.preventDefault(); setMediaDropTarget(track.id); }}
              onDragLeave={() => setMediaDropTarget(null)}
              onDrop={e => onMediaDrop(e, track.id)}
            >
              <div className="track-header" onClick={e => e.stopPropagation()}>
                <div className="track-info">
                  {track.type === 'video'
                    ? <Film size={12} className="track-type-icon video" />
                    : <Music size={12} className="track-type-icon audio" />}
                  <span>{track.name}</span>
                </div>
                <div className="track-controls">
                  {track.type === 'video' ? (
                    <button
                      className={`track-control-btn ${!track.visible ? 'off' : ''}`}
                      onClick={() => toggleTrackVisible(track.id)}
                      title={track.visible ? 'Hide' : 'Show'}
                    >
                      {track.visible ? <Eye size={11} /> : <EyeOff size={11} />}
                    </button>
                  ) : (
                    <button
                      className={`track-control-btn ${track.muted ? 'off' : ''}`}
                      onClick={() => toggleTrackMute(track.id)}
                      title={track.muted ? 'Unmute' : 'Mute'}
                    >
                      {track.muted ? <VolumeX size={11} /> : <Volume2 size={11} />}
                    </button>
                  )}
                  <button
                    className={`track-control-btn ${track.locked ? 'off' : ''}`}
                    onClick={() => toggleTrackLock(track.id)}
                    title={track.locked ? 'Unlock' : 'Lock'}
                  >
                    {track.locked ? <Lock size={11} /> : <Unlock size={11} />}
                  </button>
                </div>
              </div>
              <div className="track-content">
                {track.clips.map(clip => {
                  const sel = state.selectedClipId === clip.id;
                  const dragging = drag?.clipId === clip.id;
                  const color = clipColorForMedia(clip.mediaId);
                  const widthPx = Math.max(clip.duration * pxPerSec, 4);
                  const isVideo = clip.type === 'video' || clip.type === 'image';
                  const isAudio = clip.type === 'audio';
                  const fb = trimFeedback?.clipId === clip.id ? trimFeedback : null;

                  /* Transition zone indicator at clip start */
                  const hasTransition = !!clip.transition;
                  const transDurPx = hasTransition ? clip.transition!.duration * pxPerSec : 0;
                  const transSelected = state.selectedTransitionClipId === clip.id;

                  return (
                    <React.Fragment key={clip.id}>
                      {/* Transition zone overlay on clip */}
                      {hasTransition && (
                        <div
                          className={`timeline-transition-zone${transSelected ? ' selected' : ''}`}
                          style={{
                            left: (clip.startOffset - clip.transition!.duration / 2) * pxPerSec,
                            width: transDurPx,
                          }}
                          onClick={e => { e.stopPropagation(); selectTransition(clip.id); }}
                          title={`${clip.transition!.type} · ${clip.transition!.duration.toFixed(1)}s — click to select`}
                        >
                          <div className="transition-zone-icon">
                            <Sparkles size={10} />
                          </div>
                          <span className="transition-zone-label">{clip.transition!.type}</span>
                        </div>
                      )}
                      <div
                        className={`timeline-clip${sel ? ' selected' : ''}${dragging ? ' dragging' : ''}${track.locked ? ' locked' : ''} clip-type-${clip.type}`}
                        style={{
                          left: clip.startOffset * pxPerSec,
                          width: widthPx,
                          '--clip-color': color,
                        } as React.CSSProperties}
                        onMouseDown={e => !track.locked && onClipMouseDown(e, clip, track.id)}
                        onContextMenu={e => onClipContextMenu(e, clip, track.id)}
                        onClick={e => e.stopPropagation()}
                      >
                        {/* Square thumbnail on left for video clips */}
                        {isVideo && clip.thumbnail && (
                          <div className="clip-thumb-square">
                            <img src={clip.thumbnail} alt="" draggable={false} />
                          </div>
                        )}

                        {/* Audio waveform placeholder */}
                        {isAudio && (
                          <div className="clip-waveform">
                            {Array.from({ length: Math.max(3, Math.floor(widthPx / 3)) }, (_, i) => {
                              // Deterministic pseudo-random based on clip id hash + index
                              const seed = (clip.id.charCodeAt(i % clip.id.length) * 31 + i * 17) % 100;
                              return (
                                <div key={i} className="waveform-bar" style={{ height: `${20 + Math.sin(i * 0.7) * 30 + seed * 0.25}%` }} />
                              );
                            })}
                          </div>
                        )}

                        <div className="clip-handle clip-handle-left" title="Drag to trim in-point" />
                        <div className="clip-body">
                          <span className="clip-label">{shortClipName(clip.name)}</span>
                          {widthPx > 60 && (
                            <span className="clip-duration">{fmtDur(clip.duration)}</span>
                          )}
                        </div>
                        <div className="clip-handle clip-handle-right" title="Drag to trim out-point" />

                        {/* Trim feedback tooltip */}
                        {fb && (
                          <div className={`trim-tooltip trim-tooltip-${fb.side}`}>
                            {fb.label}
                          </div>
                        )}
                      </div>
                    </React.Fragment>
                  );
                })}

                {/* Add-transition hotspots between adjacent clips */}
                {(() => {
                  const sorted = [...track.clips].sort((a, b) => a.startOffset - b.startOffset);
                  const spots: JSX.Element[] = [];
                  for (let i = 1; i < sorted.length; i++) {
                    const prev = sorted[i - 1];
                    const curr = sorted[i];
                    const gap = curr.startOffset - (prev.startOffset + prev.duration);
                    if (Math.abs(gap) < 0.05 && !curr.transition) {
                      const x = curr.startOffset * pxPerSec;
                      spots.push(
                        <div
                          key={`trans-add-${curr.id}`}
                          className="transition-add-hotspot"
                          style={{ left: x - 10 }}
                          onDragOver={e => e.preventDefault()}
                          onDrop={e => {
                            e.preventDefault();
                            e.stopPropagation();
                            const transType = e.dataTransfer.getData('transition-type') as TransitionType;
                            if (transType) {
                              addTransition(track.id, curr.id, { type: transType, duration: 0.5 });
                            }
                          }}
                          onClick={e => {
                            e.stopPropagation();
                            addTransition(track.id, curr.id, { type: 'fade', duration: 0.5 });
                          }}
                          title="Click to add transition (or drag from sidebar)"
                        >
                          <Plus size={10} />
                        </div>
                      );
                    }
                  }
                  return spots;
                })()}
              </div>
            </div>
          ))}

          {/* ── Subtitle track ── */}
          {state.subtitles.length > 0 && (
            <div className="track-row subtitle-track-row" style={{ minWidth: totalWidthPx }}>
              <div className="track-header" onClick={e => e.stopPropagation()}>
                <div className="track-info">
                  <Type size={12} className="track-type-icon subtitle" />
                  <span>Subtitles</span>
                </div>
              </div>
              <div className="track-content">
                {state.subtitles.map(sub => {
                  const left = sub.startTime * pxPerSec;
                  const width = Math.max((sub.endTime - sub.startTime) * pxPerSec, 20);
                  const sel = state.selectedSubtitleId === sub.id;
                  return (
                    <div
                      key={sub.id}
                      className={`timeline-subtitle${sel ? ' selected' : ''}`}
                      style={{
                        left,
                        width,
                        '--sub-color': sub.style.highlightColor || '#8b5cf6',
                      } as React.CSSProperties}
                      onClick={e => {
                        e.stopPropagation();
                        selectSubtitle(sub.id);
                        setCursorPosition(sub.startTime);
                        setSubPopupId(prev => prev === sub.id ? null : sub.id);
                      }}
                      title={sub.text}
                    >
                      <Type size={10} />
                      <span className="subtitle-clip-text">{sub.text}</span>
                    </div>
                  );
                })}

                {/* Subtitle popup editor */}
                {subPopupId && (() => {
                  const sub = state.subtitles.find(s => s.id === subPopupId);
                  if (!sub) return null;
                  const popLeft = sub.startTime * pxPerSec;
                  return (
                    <div ref={subPopupRef} className="sub-popup" style={{ left: Math.max(0, popLeft - 20) }} onClick={e => e.stopPropagation()}>
                      <div className="sub-popup-header">
                        <span>Edit Subtitle</span>
                        <button className="sub-popup-close" onClick={() => setSubPopupId(null)}>&times;</button>
                      </div>
                      <textarea
                        className="sub-popup-text"
                        value={sub.text}
                        onChange={e => updateSubtitle(sub.id, { text: e.target.value })}
                        rows={2}
                        placeholder="Subtitle text..."
                      />
                      <div className="sub-popup-row">
                        <label>Start</label>
                        <input type="number" className="sub-popup-input" value={Number(sub.startTime.toFixed(1))}
                          onChange={e => { const v = parseFloat(e.target.value); if (!isNaN(v) && v >= 0) updateSubtitle(sub.id, { startTime: v }); }}
                          step={0.1} min={0} />
                        <label>End</label>
                        <input type="number" className="sub-popup-input" value={Number(sub.endTime.toFixed(1))}
                          onChange={e => { const v = parseFloat(e.target.value); if (!isNaN(v) && v > sub.startTime) updateSubtitle(sub.id, { endTime: v }); }}
                          step={0.1} min={sub.startTime + 0.1} />
                      </div>
                      <div className="sub-popup-row">
                        <label>Font</label>
                        <select className="sub-popup-select" value={sub.style.fontFamily}
                          onChange={e => updateSubtitleStyle(sub.id, { fontFamily: e.target.value as SubtitleFontFamily })}>
                          {(['Montserrat','Poppins','Bangers','Bebas Neue','Oswald','Luckiest Guy','Permanent Marker','Fredoka'] as SubtitleFontFamily[]).map(f =>
                            <option key={f} value={f}>{f}</option>
                          )}
                        </select>
                      </div>
                      <div className="sub-popup-row">
                        <label>Size</label>
                        <input type="range" className="sub-popup-range" value={sub.style.fontSize}
                          onChange={e => updateSubtitleStyle(sub.id, { fontSize: Number(e.target.value) })}
                          min={16} max={120} />
                        <span className="sub-popup-val">{sub.style.fontSize}px</span>
                      </div>
                      <div className="sub-popup-row">
                        <label>Color</label>
                        <input type="color" className="sub-popup-color" value={sub.style.color}
                          onChange={e => updateSubtitleStyle(sub.id, { color: e.target.value })} />
                        <label>Outline</label>
                        <input type="color" className="sub-popup-color"
                          value={sub.style.strokeColor === 'transparent' ? '#000000' : sub.style.strokeColor}
                          onChange={e => updateSubtitleStyle(sub.id, { strokeColor: e.target.value })} />
                      </div>
                      <div className="sub-popup-row">
                        <label>Anim</label>
                        <select className="sub-popup-select" value={sub.style.animation}
                          onChange={e => updateSubtitleStyle(sub.id, { animation: e.target.value as SubtitleAnimation })}>
                          {(['none','pop','fade','typewriter','bounce','slide-up'] as SubtitleAnimation[]).map(a =>
                            <option key={a} value={a}>{a}</option>
                          )}
                        </select>
                      </div>
                      <button className="sub-popup-delete" onClick={() => { removeSubtitle(sub.id); setSubPopupId(null); }}>
                        <Trash2 size={11} /> Delete
                      </button>
                    </div>
                  );
                })()}
              </div>
            </div>
          )}

          {/* Playhead */}
          <div className="playhead-line" style={{ left: playheadLeft }}>
            <div className="playhead-cap" />
          </div>

          {/* Snap guide */}
          {snapLine !== null && (
            <div className="snap-guide-line" style={{ left: snapLine * pxPerSec + TRACK_HEADER_W }} />
          )}
        </div>
      </div>

      {/* Context menu */}
      {ctxMenu && (() => {
        const ctxTrack = state.tracks.find(t => t.id === ctxMenu.trackId);
        const ctxClip = ctxTrack?.clips.find(c => c.id === ctxMenu.clipId);
        const hasAdjacentPrev = ctxTrack && ctxClip && ctxTrack.clips.some(c =>
          c.id !== ctxClip.id && Math.abs((c.startOffset + c.duration) - ctxClip.startOffset) < 0.05
        );
        return (
          <div className="clip-context-menu" style={{ left: ctxMenu.x, top: ctxMenu.y }}>
            <button onClick={() => { splitClip(ctxMenu.trackId, ctxMenu.clipId, state.cursorPosition); setCtxMenu(null); }}>
              <Scissors size={13} /> Split at Playhead
            </button>
            <button onClick={() => { duplicateClip(ctxMenu.trackId, ctxMenu.clipId); setCtxMenu(null); }}>
              <Copy size={13} /> Duplicate
            </button>
            {hasAdjacentPrev && !ctxClip?.transition && (
              <button onClick={() => { addTransition(ctxMenu.trackId, ctxMenu.clipId, { type: 'fade', duration: 0.5 }); setCtxMenu(null); }}>
                <Sparkles size={13} /> Add Transition
              </button>
            )}
            {ctxClip?.transition && (
              <button onClick={() => { removeTransition(ctxMenu.trackId, ctxMenu.clipId); setCtxMenu(null); }}>
                <Sparkles size={13} /> Remove Transition
              </button>
            )}
            <div className="ctx-divider" />
            <button className="ctx-danger" onClick={() => { removeClip(ctxMenu.trackId, ctxMenu.clipId); setCtxMenu(null); }}>
              <Trash2 size={13} /> Delete
            </button>
          </div>
        );
      })()}
    </footer>
  );
};

export default Timeline;
