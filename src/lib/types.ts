export type TransitionType =
  | 'fade'          // Dip to black
  | 'dissolve'      // Cross dissolve (soft dip)
  | 'flash'         // Flash to white
  | 'wipe-left'     // Wipe left-to-right
  | 'wipe-right'    // Wipe right-to-left
  | 'slide-left'    // Slide in from right
  | 'slide-right'   // Slide in from left
  | 'zoom'          // Zoom in/out
  | 'blur';         // Blur transition

export interface ClipTransition {
  type: TransitionType;
  duration: number; // seconds (0.1 – 3.0)
}

export interface MediaItem {
  id: string;
  name: string;
  path: string;
  type: 'video' | 'audio' | 'image';
  duration: number; // in seconds
}

export interface Clip {
  id: string;
  mediaId: string;
  trackId: string;
  type: 'video' | 'audio' | 'image';
  startOffset: number; // position on track timeline in seconds
  duration: number; // trimmed duration on timeline
  sourceStart: number; // in/out point on source media
  speedMultiplier: number; // e.g. 1.0 = normal, 2.0 = double speed
  volume: number; // e.g. 1.0 = 100%
  name: string;
  path: string;
  thumbnail?: string; // base64 data URL of first frame
  transition?: ClipTransition; // transition INTO this clip from previous
}

export interface Track {
  id: string;
  name: string;
  type: 'video' | 'audio';
  clips: Clip[];
  muted: boolean;
  locked: boolean;
  visible: boolean;
}

export type SidebarTab = 'media' | 'text' | 'transitions' | 'filters';

export interface ProjectState {
  mediaLibrary: MediaItem[];
  tracks: Track[];
  cursorPosition: number;
  scale: number;
  selectedClipId: string | null;
  selectedTransitionClipId: string | null;
  snapEnabled: boolean;
  isPlaying: boolean;
  projectName: string;
  sidebarTab: SidebarTab;
  sidebarOpen: boolean;
}
