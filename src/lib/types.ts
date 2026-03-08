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

/* ─── Subtitle / Text Overlay types ─── */

export type SubtitleFontFamily =
  | 'Montserrat'
  | 'Poppins'
  | 'Bangers'
  | 'Bebas Neue'
  | 'Oswald'
  | 'Luckiest Guy'
  | 'Permanent Marker'
  | 'Fredoka';

export type SubtitleAnimation =
  | 'none'
  | 'pop'
  | 'fade'
  | 'typewriter'
  | 'bounce'
  | 'slide-up';

export type SubtitlePosition = 'top' | 'center' | 'bottom';

export interface SubtitleStyle {
  fontFamily: SubtitleFontFamily;
  fontSize: number;        // px (24–120)
  fontWeight: number;      // 400–900
  color: string;           // hex
  highlightColor: string;  // accent word color (for karaoke style)
  strokeColor: string;     // text outline color
  strokeWidth: number;     // px (0–8)
  backgroundColor: string; // behind text (rgba)
  backgroundPadding: number;
  backgroundRadius: number;
  position: SubtitlePosition;
  animation: SubtitleAnimation;
  uppercase: boolean;
  letterSpacing: number;   // px
  lineHeight: number;      // multiplier e.g. 1.2
  customX?: number;        // 0–100% from left (overrides position)
  customY?: number;        // 0–100% from top (overrides position)
  maxWidth: number;        // 10–100% of container width
}

export interface SubtitleItem {
  id: string;
  text: string;
  startTime: number;  // seconds on timeline
  endTime: number;    // seconds on timeline
  style: SubtitleStyle;
}

export type SubtitlePresetId =
  | 'bold-pop'
  | 'karaoke'
  | 'neon'
  | 'clean'
  | 'handwritten'
  | 'comic'
  | 'minimal'
  | 'bold-outline';

export type SidebarTab = 'media' | 'text' | 'transitions' | 'filters';

export interface ProjectState {
  mediaLibrary: MediaItem[];
  tracks: Track[];
  subtitles: SubtitleItem[];
  globalSubtitleStyle: SubtitleStyle;
  selectedSubtitleId: string | null;
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
