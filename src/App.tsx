import {
    Download, Film,
    Image as ImageIcon,
    Loader2,
    Redo2, Scissors, Sparkles, Type, Undo2,
} from 'lucide-react';
import { useState } from 'react';
import MediaBin from './components/MediaBin';
import Player from './components/Player';
import PropertiesPanel from './components/PropertiesPanel';
import Timeline from './components/Timeline';
import TransitionsBin from './components/TransitionsBin';
import './index.css';
import { TimelineProvider, useTimelineContext } from './lib/TimelineContext';
import { SidebarTab } from './lib/types';

/* ─── Sidebar icon rail (like Clipchamp left bar) ─── */

const SIDEBAR_TABS: { id: SidebarTab; icon: React.ReactNode; label: string }[] = [
  { id: 'media', icon: <Film size={20} />, label: 'Your media' },
  { id: 'text', icon: <Type size={20} />, label: 'Text' },
  { id: 'transitions', icon: <Sparkles size={20} />, label: 'Transitions' },
  { id: 'filters', icon: <ImageIcon size={20} />, label: 'Filters' },
];

function SidebarRail() {
  const { state, setSidebarTab, toggleSidebar } = useTimelineContext();

  return (
    <nav className="sidebar-rail">
      {SIDEBAR_TABS.map(tab => (
        <button
          key={tab.id}
          className={`rail-btn ${state.sidebarTab === tab.id && state.sidebarOpen ? 'active' : ''}`}
          onClick={() =>
            state.sidebarTab === tab.id && state.sidebarOpen ? toggleSidebar() : setSidebarTab(tab.id)
          }
          title={tab.label}
        >
          {tab.icon}
          <span className="rail-label">{tab.label}</span>
        </button>
      ))}
    </nav>
  );
}

/* ─── Sidebar panel content ─── */

function SidebarPanel() {
  const { state } = useTimelineContext();
  if (!state.sidebarOpen) return null;

  return (
    <aside className="sidebar-panel">
      {state.sidebarTab === 'media' && <MediaBin />}
      {state.sidebarTab === 'text' && (
        <div className="sidebar-placeholder">
          <Type size={32} opacity={0.2} />
          <h3>Text Overlays</h3>
          <p>Add titles, captions, and lower thirds to your video.</p>
          <span className="coming-soon-badge">Coming soon</span>
        </div>
      )}
      {state.sidebarTab === 'transitions' && <TransitionsBin />}
      {state.sidebarTab === 'filters' && (
        <div className="sidebar-placeholder">
          <ImageIcon size={32} opacity={0.2} />
          <h3>Filters & Effects</h3>
          <p>Apply color grading and visual effects.</p>
          <span className="coming-soon-badge">Coming soon</span>
        </div>
      )}
    </aside>
  );
}

/* ─── App Header ─── */

function AppHeader() {
  const { state, setProjectName, undo, redo, canUndo, canRedo } = useTimelineContext();
  const [exporting, setExporting] = useState(false);
  const [editingName, setEditingName] = useState(false);

  const handleExport = async () => {
    const exportPath = await window.electronAPI.showExportDialog();
    if (!exportPath) return;
    setExporting(true);
    try {
      const result = await window.electronAPI.exportVideo(state, exportPath);
      if (result.success) {
        alert(`Exported successfully to ${result.path}`);
      } else {
        alert(`Export failed: ${result.error}`);
      }
    } catch (e: any) {
      alert(`Export error: ${e.message}`);
    }
    setExporting(false);
  };

  return (
    <header className="app-header">
      <div className="header-left">
        <div className="brand">
          <Scissors size={20} strokeWidth={2.5} />
          <span>ClipVid</span>
        </div>
        <div className="header-divider" />
        {editingName ? (
          <input
            className="project-name-input"
            value={state.projectName}
            onChange={e => setProjectName(e.target.value)}
            onBlur={() => setEditingName(false)}
            onKeyDown={e => e.key === 'Enter' && setEditingName(false)}
            autoFocus
          />
        ) : (
          <button className="project-name-btn" onClick={() => setEditingName(true)}>
            {state.projectName}
          </button>
        )}
      </div>

      <div className="header-center">
        <button className="header-icon-btn" onClick={undo} disabled={!canUndo} title="Undo (Ctrl+Z)">
          <Undo2 size={18} />
        </button>
        <button className="header-icon-btn" onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Y)">
          <Redo2 size={18} />
        </button>
      </div>

      <div className="header-right">
        <button
          className="btn-primary"
          onClick={handleExport}
          disabled={exporting}
        >
          {exporting ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
          {exporting ? 'Exporting...' : 'Export'}
        </button>
      </div>
    </header>
  );
}

/* ─── Main content layout ─── */

function AppContent() {
  const { state } = useTimelineContext();
  const selectedClip = state.selectedClipId
    ? (() => { for (const t of state.tracks) { const c = t.clips.find(c => c.id === state.selectedClipId); if (c) return c; } return null; })()
    : null;
  const hasTransitionSelection = !!state.selectedTransitionClipId;

  return (
    <div className="app-container">
      <AppHeader />
      <div className="app-body">
        <SidebarRail />
        <SidebarPanel />
        <main className="app-main">
          <Player />
        </main>
        {(selectedClip || hasTransitionSelection) && <PropertiesPanel />}
      </div>
      <Timeline />
    </div>
  );
}

function App() {
  return (
    <TimelineProvider>
      <AppContent />
    </TimelineProvider>
  );
}

export default App;
