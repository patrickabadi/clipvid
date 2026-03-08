import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  openFile: () => ipcRenderer.invoke('dialog:openFile'),
  getMediaInfo: (filePath: string) => ipcRenderer.invoke('ffmpeg:getInfo', filePath),
  getThumbnail: (filePath: string, timestamp: number) => ipcRenderer.invoke('ffmpeg:getThumbnail', filePath, timestamp),
  showExportDialog: () => ipcRenderer.invoke('dialog:showExportDialog'),
  exportVideo: (timelineData: any, returnPath: string) => ipcRenderer.invoke('ffmpeg:exportVideo', timelineData, returnPath),
  getFileUrl: (filePath: string) => `media://load/${encodeURIComponent(filePath)}`,
  transcribeVideo: (filePath: string, timelineOffset: number, sourceStart: number, clipDuration: number, speedMultiplier: number) => ipcRenderer.invoke('transcribe:extractSubtitles', filePath, timelineOffset, sourceStart, clipDuration, speedMultiplier),
  onTranscribeProgress: (callback: (data: { stage: string; progress: number }) => void) => {
    const handler = (_event: any, data: { stage: string; progress: number }) => callback(data);
    ipcRenderer.on('transcribe:progress', handler);
    return () => ipcRenderer.removeListener('transcribe:progress', handler);
  },
});
