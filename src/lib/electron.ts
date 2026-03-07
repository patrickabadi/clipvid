export interface ElectronAPI {
  openFile: () => Promise<Array<{ path: string; name: string; type: 'video' | 'audio' | 'image' }>>;
  getMediaInfo: (filePath: string) => Promise<{ duration: number }>;
  getThumbnail: (filePath: string, timestamp: number) => Promise<string>;
  showExportDialog: () => Promise<string | null>;
  exportVideo: (timelineData: any, returnPath: string) => Promise<{ success: boolean; path?: string; error?: string }>;
  getFileUrl: (filePath: string) => string;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

export const electron = window.electronAPI;
