import { Film, Music, Search, Trash2, UploadCloud } from 'lucide-react';
import React, { useState } from 'react';
import { useTimelineContext } from '../lib/TimelineContext';
import { MediaItem } from '../lib/types';

function getMediaUrl(filePath: string): string {
  if (window.electronAPI?.getFileUrl) {
    return window.electronAPI.getFileUrl(filePath);
  }
  return filePath;
}

function MediaThumbnail({ item }: { item: MediaItem }) {
  if (item.type === 'video') {
    return (
      <div className="media-item-thumb">
        <video src={getMediaUrl(item.path)} preload="metadata" muted />
        <div className="media-thumb-overlay"><Film size={12} /></div>
      </div>
    );
  }
  if (item.type === 'image') {
    return (
      <div className="media-item-thumb">
        <img src={getMediaUrl(item.path)} alt={item.name} />
      </div>
    );
  }
  return (
    <div className="media-item-icon">
      <Music size={16} color="var(--clip-audio)" />
    </div>
  );
}

const MediaBin: React.FC = () => {
  const { state, addMediaToLibrary, removeMedia } = useTimelineContext();
  const [search, setSearch] = useState('');

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    const files = e.dataTransfer.files;

    Array.from(files).forEach(async (file: any) => {
      const path = file.path;
      if (!path) return;

      const type = path.match(/\.(mp3|wav|aac|flac|ogg)$/i) ? 'audio' :
                   path.match(/\.(png|jpg|jpeg|gif|webp|bmp)$/i) ? 'image' : 'video';

      const info = await window.electronAPI.getMediaInfo(path);

      addMediaToLibrary({
        id: Math.random().toString(36).substr(2, 9),
        name: file.name,
        path: path,
        type: type as 'audio'|'image'|'video',
        duration: info.duration || 10,
      });
    });
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleOpenDialog = async () => {
    if (!window.electronAPI) return;
    const files = await window.electronAPI.openFile();
    files.forEach(async f => {
      const info = await window.electronAPI.getMediaInfo(f.path);
      addMediaToLibrary({
        id: Math.random().toString(36).substr(2, 9),
        name: f.name,
        path: f.path,
        type: f.type,
        duration: info.duration || 10
      });
    });
  };

  const formatDuration = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  // Strip extension and UUID from name for clean display
  const cleanName = (name: string) => {
    let n = name.replace(/\.[^.]+$/, '');
    n = n.replace(/_?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '');
    n = n.replace(/[_-]+$/, '');
    return n || name;
  };

  const filteredItems = state.mediaLibrary.filter(item =>
    item.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="media-bin">
      <div className="sidebar-section-header">
        <h3>Your media</h3>
        <span className="media-count">{state.mediaLibrary.length} items</span>
      </div>

      {/* Search */}
      <div className="media-search">
        <Search size={14} />
        <input
          type="text"
          placeholder="Search media..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      {/* Drop zone */}
      <div
        className="drop-zone"
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onClick={handleOpenDialog}
      >
        <UploadCloud size={20} />
        <span>Import media</span>
        <span className="drop-sub">Drop files or click to browse</span>
      </div>

      {/* Media list */}
      <div className="media-items">
        {filteredItems.map(item => (
          <div key={item.id} className="media-item" draggable onDragStart={(e) => {
            e.dataTransfer.setData('source-media-id', item.id);
          }}>
            <MediaThumbnail item={item} />
            <div className="media-item-details">
              <span className="media-item-name" title={item.name}>{cleanName(item.name)}</span>
              <span className="media-item-duration">
                {item.type !== 'image' ? formatDuration(item.duration) : 'Image'}
              </span>
            </div>
            <button
              className="media-item-remove"
              onClick={e => { e.stopPropagation(); removeMedia(item.id); }}
              title="Remove from library"
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
        {filteredItems.length === 0 && state.mediaLibrary.length > 0 && (
          <div className="media-empty">No results for "{search}"</div>
        )}
      </div>
    </div>
  );
};

export default MediaBin;
