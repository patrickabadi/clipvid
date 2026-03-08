export interface TranscribeResult {
  success: boolean;
  subtitles?: Array<{ text: string; startTime: number; endTime: number }>;
  error?: string;
}

export interface ElectronAPI {
  openFile: () => Promise<Array<{ path: string; name: string; type: 'video' | 'audio' | 'image' }>>;
  getMediaInfo: (filePath: string) => Promise<{ duration: number }>;
  getThumbnail: (filePath: string, timestamp: number) => Promise<string>;
  showExportDialog: () => Promise<string | null>;
  exportVideo: (timelineData: any, returnPath: string) => Promise<{ success: boolean; path?: string; error?: string }>;
  getFileUrl: (filePath: string) => string;
  transcribeVideo: (filePath: string, timelineOffset: number, sourceStart: number, clipDuration: number, speedMultiplier: number) => Promise<TranscribeResult>;
  onTranscribeProgress: (callback: (data: { stage: string; progress: number }) => void) => () => void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

export const electron = window.electronAPI;
