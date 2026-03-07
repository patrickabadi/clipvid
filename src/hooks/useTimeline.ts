import { useCallback, useEffect, useRef, useState } from 'react';
import { Clip, ClipTransition, MediaItem, ProjectState, SidebarTab, Track } from '../lib/types';

/** Fetch a thumbnail from Electron's ffmpeg backend; returns '' if unavailable */
function fetchThumbnail(filePath: string, timestamp: number): Promise<string> {
  if (!window.electronAPI?.getThumbnail) return Promise.resolve('');
  return window.electronAPI.getThumbnail(filePath, Math.max(0, timestamp)).catch(() => '');
}

const initialState: ProjectState = {
  mediaLibrary: [],
  tracks: [
    { id: 'v2', name: 'Video 2', type: 'video', clips: [], muted: false, locked: false, visible: true },
    { id: 'v1', name: 'Video 1', type: 'video', clips: [], muted: false, locked: false, visible: true },
    { id: 'a1', name: 'Audio 1', type: 'audio', clips: [], muted: false, locked: false, visible: true },
    { id: 'a2', name: 'Audio 2', type: 'audio', clips: [], muted: false, locked: false, visible: true },
  ],
  cursorPosition: 0,
  scale: 1,
  selectedClipId: null,
  selectedTransitionClipId: null,
  snapEnabled: true,
  isPlaying: false,
  projectName: 'Untitled Project',
  sidebarTab: 'media',
  sidebarOpen: true,
};

const MAX_UNDO = 40;

export function useTimeline() {
  const [state, setState] = useState<ProjectState>(initialState);
  const undoStack = useRef<ProjectState[]>([]);
  const redoStack = useRef<ProjectState[]>([]);
  const [_stackVer, _setStackVer] = useState(0);

  const pushUndo = useCallback(() => {
    setState(prev => {
      undoStack.current.push(prev);
      if (undoStack.current.length > MAX_UNDO) undoStack.current.shift();
      redoStack.current = [];
      return prev;
    });
    _setStackVer(v => v + 1);
  }, []);

  const undo = useCallback(() => {
    setState(prev => {
      const snap = undoStack.current.pop();
      if (!snap) return prev;
      redoStack.current.push(prev);
      return { ...snap, isPlaying: false };
    });
    _setStackVer(v => v + 1);
  }, []);

  const redo = useCallback(() => {
    setState(prev => {
      const snap = redoStack.current.pop();
      if (!snap) return prev;
      undoStack.current.push(prev);
      return { ...snap, isPlaying: false };
    });
    _setStackVer(v => v + 1);
  }, []);

  // _stackVer triggers re-render so these recompute correctly
  const canUndo = _stackVer >= 0 && undoStack.current.length > 0;
  const canRedo = _stackVer >= 0 && redoStack.current.length > 0;

  const addMediaToLibrary = useCallback((item: MediaItem) => {
    setState(prev => ({ ...prev, mediaLibrary: [...prev.mediaLibrary, item] }));
  }, []);

  const removeMedia = useCallback((mediaId: string) => {
    pushUndo();
    setState(prev => ({
      ...prev,
      mediaLibrary: prev.mediaLibrary.filter(m => m.id !== mediaId),
      tracks: prev.tracks.map(t => ({
        ...t,
        clips: t.clips.filter(c => c.mediaId !== mediaId),
      })),
    }));
  }, [pushUndo]);

  const addClip = useCallback((trackId: string, clip: Clip) => {
    pushUndo();
    setState(prev => {
      const track = prev.tracks.find(t => t.id === trackId);
      if (!track || track.locked) return prev;

      const overlaps = track.clips.some(c =>
        clip.startOffset < c.startOffset + c.duration &&
        clip.startOffset + clip.duration > c.startOffset
      );
      if (overlaps) {
        const pushTo = track.clips.reduce((max, c) => {
          if (clip.startOffset < c.startOffset + c.duration &&
              clip.startOffset + clip.duration > c.startOffset) {
            return Math.max(max, c.startOffset + c.duration);
          }
          return max;
        }, clip.startOffset);
        clip = { ...clip, startOffset: pushTo };
      }

      return {
        ...prev,
        tracks: prev.tracks.map(t =>
          t.id === trackId ? { ...t, clips: [...t.clips, clip] } : t
        ),
      };
    });

    // Async thumbnail fetch for video/image clips
    if (clip.type === 'video' || clip.type === 'image') {
      fetchThumbnail(clip.path, clip.sourceStart).then(thumb => {
        if (!thumb) return;
        setState(prev => ({
          ...prev,
          tracks: prev.tracks.map(t =>
            t.id === trackId
              ? { ...t, clips: t.clips.map(c => c.id === clip.id ? { ...c, thumbnail: thumb } : c) }
              : t
          ),
        }));
      });
    }
  }, [pushUndo]);

  const updateClip = useCallback((trackId: string, clipId: string, updates: Partial<Clip>) => {
    setState(prev => {
      const track = prev.tracks.find(t => t.id === trackId);
      if (!track || track.locked) return prev;
      const clip = track.clips.find(c => c.id === clipId);
      if (!clip) return prev;
      const proposed = { ...clip, ...updates };
      const wouldOverlap = track.clips.some(c =>
        c.id !== clipId &&
        proposed.startOffset < c.startOffset + c.duration &&
        proposed.startOffset + proposed.duration > c.startOffset
      );
      if (wouldOverlap) return prev;
      return {
        ...prev,
        tracks: prev.tracks.map(t =>
          t.id === trackId
            ? { ...t, clips: t.clips.map(c => c.id === clipId ? proposed : c) }
            : t
        ),
      };
    });
  }, []);

  const moveClipToTrack = useCallback((fromTrackId: string, clipId: string, toTrackId: string, newStartOffset?: number) => {
    setState(prev => {
      if (fromTrackId === toTrackId) return prev;
      const fromTrack = prev.tracks.find(t => t.id === fromTrackId);
      const toTrack = prev.tracks.find(t => t.id === toTrackId);
      if (!fromTrack || !toTrack || toTrack.locked) return prev;
      const clip = fromTrack.clips.find(c => c.id === clipId);
      if (!clip) return prev;
      const clipIsVideo = clip.type === 'video' || clip.type === 'image';
      if (clipIsVideo && toTrack.type !== 'video') return prev;
      if (clip.type === 'audio' && toTrack.type !== 'audio') return prev;
      const movedClip = { ...clip, trackId: toTrackId, startOffset: newStartOffset ?? clip.startOffset };
      const wouldOverlap = toTrack.clips.some(c =>
        movedClip.startOffset < c.startOffset + c.duration &&
        movedClip.startOffset + movedClip.duration > c.startOffset
      );
      if (wouldOverlap) return prev;
      return {
        ...prev,
        tracks: prev.tracks.map(t => {
          if (t.id === fromTrackId) return { ...t, clips: t.clips.filter(c => c.id !== clipId) };
          if (t.id === toTrackId) return { ...t, clips: [...t.clips, movedClip] };
          return t;
        }),
      };
    });
  }, []);

  const removeClip = useCallback((trackId: string, clipId: string) => {
    pushUndo();
    setState(prev => ({
      ...prev,
      selectedClipId: prev.selectedClipId === clipId ? null : prev.selectedClipId,
      selectedTransitionClipId: prev.selectedTransitionClipId === clipId ? null : prev.selectedTransitionClipId,
      tracks: prev.tracks.map(t =>
        t.id === trackId ? { ...t, clips: t.clips.filter(c => c.id !== clipId) } : t
      ),
    }));
  }, [pushUndo]);

  const splitClip = useCallback((trackId: string, clipId: string, splitTime: number) => {
    pushUndo();
    let rightClipId = '';
    let rightClipPath = '';
    let rightClipSourceStart = 0;
    let rightClipType: Clip['type'] = 'video';

    setState(prev => {
      const track = prev.tracks.find(t => t.id === trackId);
      if (!track || track.locked) return prev;
      const clip = track.clips.find(c => c.id === clipId);
      if (!clip) return prev;
      const relSplit = splitTime - clip.startOffset;
      if (relSplit <= 0 || relSplit >= clip.duration) return prev;
      const leftClip: Clip = { ...clip, duration: relSplit };
      const newId = Math.random().toString(36).substr(2, 12);
      const newSourceStart = clip.sourceStart + relSplit * clip.speedMultiplier;
      const rightClip: Clip = {
        ...clip,
        id: newId,
        startOffset: splitTime,
        duration: clip.duration - relSplit,
        sourceStart: newSourceStart,
        thumbnail: undefined, // will be populated async
      };
      rightClipId = newId;
      rightClipPath = clip.path;
      rightClipSourceStart = newSourceStart;
      rightClipType = clip.type;
      return {
        ...prev,
        tracks: prev.tracks.map(t =>
          t.id === trackId
            ? { ...t, clips: t.clips.map(c => c.id === clipId ? leftClip : c).concat(rightClip) }
            : t
        ),
      };
    });

    // Async thumbnail for the new right clip
    if (rightClipId && (rightClipType === 'video' || rightClipType === 'image')) {
      fetchThumbnail(rightClipPath, rightClipSourceStart).then(thumb => {
        if (!thumb) return;
        setState(prev => ({
          ...prev,
          tracks: prev.tracks.map(t =>
            t.id === trackId
              ? { ...t, clips: t.clips.map(c => c.id === rightClipId ? { ...c, thumbnail: thumb } : c) }
              : t
          ),
        }));
      });
    }
  }, [pushUndo]);

  const selectClip = useCallback((clipId: string | null) => {
    setState(prev => ({ ...prev, selectedClipId: clipId, selectedTransitionClipId: null }));
  }, []);

  const selectTransition = useCallback((clipId: string | null) => {
    setState(prev => ({ ...prev, selectedTransitionClipId: clipId, selectedClipId: clipId ? null : prev.selectedClipId }));
  }, []);

  const addTransition = useCallback((trackId: string, clipId: string, transition: ClipTransition) => {
    pushUndo();
    setState(prev => ({
      ...prev,
      selectedTransitionClipId: clipId,
      selectedClipId: null,
      tracks: prev.tracks.map(t =>
        t.id === trackId
          ? { ...t, clips: t.clips.map(c => c.id === clipId ? { ...c, transition } : c) }
          : t
      ),
    }));
  }, [pushUndo]);

  const updateTransition = useCallback((trackId: string, clipId: string, updates: Partial<ClipTransition>) => {
    setState(prev => ({
      ...prev,
      tracks: prev.tracks.map(t =>
        t.id === trackId
          ? {
              ...t,
              clips: t.clips.map(c =>
                c.id === clipId && c.transition
                  ? { ...c, transition: { ...c.transition, ...updates } }
                  : c
              ),
            }
          : t
      ),
    }));
  }, []);

  const removeTransition = useCallback((trackId: string, clipId: string) => {
    pushUndo();
    setState(prev => ({
      ...prev,
      selectedTransitionClipId: prev.selectedTransitionClipId === clipId ? null : prev.selectedTransitionClipId,
      tracks: prev.tracks.map(t =>
        t.id === trackId
          ? { ...t, clips: t.clips.map(c => c.id === clipId ? { ...c, transition: undefined } : c) }
          : t
      ),
    }));
  }, [pushUndo]);

  const setCursorPosition = useCallback((pos: number) => {
    setState(prev => ({ ...prev, cursorPosition: pos }));
  }, []);

  const setScale = useCallback((scale: number) => {
    setState(prev => ({ ...prev, scale }));
  }, []);

  const toggleSnap = useCallback(() => {
    setState(prev => ({ ...prev, snapEnabled: !prev.snapEnabled }));
  }, []);

  const togglePlayback = useCallback(() => {
    setState(prev => ({ ...prev, isPlaying: !prev.isPlaying }));
  }, []);

  const stopPlayback = useCallback(() => {
    setState(prev => ({ ...prev, isPlaying: false }));
  }, []);

  const skipBackward = useCallback(() => {
    setState(prev => ({ ...prev, isPlaying: false, cursorPosition: Math.max(0, prev.cursorPosition - 5) }));
  }, []);

  const skipForward = useCallback(() => {
    setState(prev => ({ ...prev, cursorPosition: prev.cursorPosition + 5 }));
  }, []);

  const jumpToStart = useCallback(() => {
    setState(prev => ({ ...prev, isPlaying: false, cursorPosition: 0 }));
  }, []);

  const jumpToEnd = useCallback(() => {
    setState(prev => {
      let maxEnd = 0;
      prev.tracks.forEach(t => t.clips.forEach(c => { maxEnd = Math.max(maxEnd, c.startOffset + c.duration); }));
      return { ...prev, isPlaying: false, cursorPosition: maxEnd };
    });
  }, []);

  const fitToTimeline = useCallback((viewportWidthPx: number) => {
    setState(prev => {
      let maxEnd = 0;
      prev.tracks.forEach(t => t.clips.forEach(c => { maxEnd = Math.max(maxEnd, c.startOffset + c.duration); }));
      if (maxEnd <= 0) return prev;
      const availableWidth = viewportWidthPx - 180 - 40;
      const idealScale = availableWidth / (maxEnd * 50);
      return { ...prev, scale: Math.max(0.05, Math.min(10, idealScale)) };
    });
  }, []);

  const toggleTrackMute = useCallback((trackId: string) => {
    setState(prev => ({ ...prev, tracks: prev.tracks.map(t => t.id === trackId ? { ...t, muted: !t.muted } : t) }));
  }, []);

  const toggleTrackLock = useCallback((trackId: string) => {
    setState(prev => ({ ...prev, tracks: prev.tracks.map(t => t.id === trackId ? { ...t, locked: !t.locked } : t) }));
  }, []);

  const toggleTrackVisible = useCallback((trackId: string) => {
    setState(prev => ({ ...prev, tracks: prev.tracks.map(t => t.id === trackId ? { ...t, visible: !t.visible } : t) }));
  }, []);

  const removeTrack = useCallback((trackId: string) => {
    pushUndo();
    setState(prev => ({ ...prev, tracks: prev.tracks.filter(t => t.id !== trackId) }));
  }, [pushUndo]);

  const setProjectName = useCallback((name: string) => {
    setState(prev => ({ ...prev, projectName: name }));
  }, []);

  const setSidebarTab = useCallback((tab: SidebarTab) => {
    setState(prev => ({ ...prev, sidebarTab: tab, sidebarOpen: true }));
  }, []);

  const toggleSidebar = useCallback(() => {
    setState(prev => ({ ...prev, sidebarOpen: !prev.sidebarOpen }));
  }, []);

  const duplicateClip = useCallback((trackId: string, clipId: string) => {
    pushUndo();
    setState(prev => {
      const track = prev.tracks.find(t => t.id === trackId);
      if (!track) return prev;
      const clip = track.clips.find(c => c.id === clipId);
      if (!clip) return prev;
      const newClip: Clip = { ...clip, id: Math.random().toString(36).substr(2, 12), startOffset: clip.startOffset + clip.duration };
      const wouldOverlap = track.clips.some(c =>
        newClip.startOffset < c.startOffset + c.duration && newClip.startOffset + newClip.duration > c.startOffset
      );
      if (wouldOverlap) return prev;
      return { ...prev, selectedClipId: newClip.id, tracks: prev.tracks.map(t => t.id === trackId ? { ...t, clips: [...t.clips, newClip] } : t) };
    });
  }, [pushUndo]);

  const addTrack = useCallback((type: 'video' | 'audio') => {
    setState(prev => {
      const count = prev.tracks.filter(t => t.type === type).length;
      const newTrack: Track = {
        id: `${type[0]}${count + 1}_${Date.now()}`,
        name: `${type === 'video' ? 'Video' : 'Audio'} ${count + 1}`,
        type, clips: [], muted: false, locked: false, visible: true,
      };
      return type === 'video'
        ? { ...prev, tracks: [newTrack, ...prev.tracks] }
        : { ...prev, tracks: [...prev.tracks, newTrack] };
    });
  }, []);

  // Undo/redo keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if ((e.ctrlKey || e.metaKey) && (key === 'y' || (key === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  return {
    state,
    addMediaToLibrary, removeMedia, addClip, updateClip, moveClipToTrack, removeClip, splitClip, duplicateClip,
    selectClip, selectTransition, addTransition, updateTransition, removeTransition,
    setCursorPosition, setScale, toggleSnap, addTrack, removeTrack,
    togglePlayback, stopPlayback, skipBackward, skipForward, jumpToStart, jumpToEnd,
    fitToTimeline, toggleTrackMute, toggleTrackLock, toggleTrackVisible,
    setProjectName, setSidebarTab, toggleSidebar,
    undo, redo, canUndo, canRedo, pushUndo,
  };
}
