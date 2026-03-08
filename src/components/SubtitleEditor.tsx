import {
    AlignCenter, Bold, ChevronDown, ChevronUp, Loader2, Mic, Palette,
    Trash2, Type, Wand2,
} from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTimelineContext } from '../lib/TimelineContext';
import {
    SubtitleAnimation, SubtitleFontFamily, SubtitleItem,
    SubtitlePosition, SubtitlePresetId, SubtitleStyle,
} from '../lib/types';

/* --- Preset definitions --- */

interface SubtitlePreset {
  id: SubtitlePresetId;
  name: string;
  style: SubtitleStyle;
}

const BASE_STYLE: SubtitleStyle = {
  fontFamily: 'Montserrat',
  fontSize: 54,
  fontWeight: 800,
  color: '#ffffff',
  highlightColor: '#8b5cf6',
  strokeColor: '#000000',
  strokeWidth: 3,
  backgroundColor: 'transparent',
  backgroundPadding: 8,
  backgroundRadius: 8,
  position: 'bottom',
  animation: 'pop',
  uppercase: true,
  letterSpacing: 1,
  lineHeight: 1.2,
  maxWidth: 90,
};

const PRESETS: SubtitlePreset[] = [
  { id: 'bold-pop', name: 'Bold Pop', style: { ...BASE_STYLE, fontFamily: 'Montserrat', fontSize: 58, fontWeight: 900, strokeWidth: 4, letterSpacing: 2 } },
  { id: 'karaoke', name: 'Karaoke', style: { ...BASE_STYLE, fontFamily: 'Poppins', fontSize: 52, fontWeight: 700, highlightColor: '#facc15', animation: 'none', uppercase: false } },
  { id: 'neon', name: 'Neon Glow', style: { ...BASE_STYLE, fontFamily: 'Bebas Neue', fontSize: 64, fontWeight: 400, color: '#22d3ee', strokeColor: '#0e7490', strokeWidth: 2, backgroundColor: 'rgba(0,0,0,0.5)', backgroundPadding: 12, backgroundRadius: 12, animation: 'fade', letterSpacing: 4 } },
  { id: 'clean', name: 'Clean', style: { ...BASE_STYLE, fontFamily: 'Poppins', fontSize: 36, fontWeight: 600, strokeColor: 'transparent', strokeWidth: 0, backgroundColor: 'rgba(0,0,0,0.65)', backgroundPadding: 14, backgroundRadius: 24, animation: 'fade', uppercase: false, letterSpacing: 0.5 } },
  { id: 'handwritten', name: 'Handwritten', style: { ...BASE_STYLE, fontFamily: 'Permanent Marker', fontSize: 48, fontWeight: 400, color: '#fef08a', position: 'center', animation: 'bounce', uppercase: false } },
  { id: 'comic', name: 'Comic', style: { ...BASE_STYLE, fontFamily: 'Bangers', fontSize: 56, fontWeight: 400, color: '#f97316', strokeWidth: 4, letterSpacing: 3 } },
  { id: 'minimal', name: 'Minimal', style: { ...BASE_STYLE, fontFamily: 'Oswald', fontSize: 32, fontWeight: 500, color: '#e2e8f0', strokeColor: 'transparent', strokeWidth: 0, backgroundColor: 'rgba(0,0,0,0.4)', backgroundPadding: 10, backgroundRadius: 6, animation: 'slide-up', letterSpacing: 2 } },
  { id: 'bold-outline', name: 'Bold Outline', style: { ...BASE_STYLE, fontFamily: 'Fredoka', fontSize: 54, fontWeight: 700, strokeColor: '#8b5cf6', strokeWidth: 5, uppercase: false } },
];

const FONT_OPTIONS: { value: SubtitleFontFamily; label: string }[] = [
  { value: 'Montserrat', label: 'Montserrat' },
  { value: 'Poppins', label: 'Poppins' },
  { value: 'Bangers', label: 'Bangers' },
  { value: 'Bebas Neue', label: 'Bebas Neue' },
  { value: 'Oswald', label: 'Oswald' },
  { value: 'Luckiest Guy', label: 'Luckiest Guy' },
  { value: 'Permanent Marker', label: 'Permanent Marker' },
  { value: 'Fredoka', label: 'Fredoka' },
];

const POSITION_OPTIONS: { value: SubtitlePosition; label: string }[] = [
  { value: 'top', label: 'Top' },
  { value: 'center', label: 'Center' },
  { value: 'bottom', label: 'Bottom' },
];

const ANIMATION_OPTIONS: { value: SubtitleAnimation; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'pop', label: 'Pop' },
  { value: 'fade', label: 'Fade' },
  { value: 'typewriter', label: 'Typewriter' },
  { value: 'bounce', label: 'Bounce' },
  { value: 'slide-up', label: 'Slide Up' },
];

const formatTime = (s: number) => {
  const m = Math.floor(s / 60);
  const sec = (s % 60).toFixed(1);
  return `${m}:${sec.padStart(4, '0')}`;
};

/* --- Preset preview card --- */

const PresetCard: React.FC<{ preset: SubtitlePreset; active: boolean; onSelect: () => void }> = ({ preset, active, onSelect }) => {
  const s = preset.style;
  const previewStyle: React.CSSProperties = {
    fontFamily: `'${s.fontFamily}', sans-serif`,
    fontSize: '14px',
    fontWeight: s.fontWeight,
    color: s.color,
    textTransform: s.uppercase ? 'uppercase' : 'none',
    letterSpacing: `${Math.min(s.letterSpacing, 2)}px`,
    WebkitTextStroke: s.strokeWidth > 0 ? `${Math.min(s.strokeWidth, 1.5)}px ${s.strokeColor}` : undefined,
    background: s.backgroundColor !== 'transparent' ? s.backgroundColor : undefined,
    padding: s.backgroundColor !== 'transparent' ? '3px 6px' : undefined,
    borderRadius: s.backgroundColor !== 'transparent' ? `${Math.min(s.backgroundRadius, 8)}px` : undefined,
    lineHeight: '1.3',
  };

  return (
    <button className={`subtitle-preset-card${active ? ' active' : ''}`} onClick={onSelect}>
      <div className="preset-preview" style={{ background: '#0f0f12' }}>
        <span style={previewStyle}>Abc</span>
      </div>
      <span className="preset-name">{preset.name}</span>
    </button>
  );
};

/* --- Main SubtitleEditor --- */

const SubtitleEditor: React.FC = () => {
  const {
    state, addSubtitlesBatch, applyGlobalStyleToAll,
    removeSubtitle, selectSubtitle, setCursorPosition, clearAllSubtitles,
  } = useTimelineContext();
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [transcribeProgress, setTranscribeProgress] = useState<{ stage: string; progress: number } | null>(null);
  const [transcribeError, setTranscribeError] = useState<string | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  const gs = state.globalSubtitleStyle;

  const activePresetId = useMemo(() => {
    for (const p of PRESETS) {
      if (p.style.fontFamily === gs.fontFamily && p.style.fontSize === gs.fontSize && p.style.color === gs.color && p.style.strokeColor === gs.strokeColor && p.style.animation === gs.animation) {
        return p.id;
      }
    }
    return null;
  }, [gs]);

  const videoClips = useMemo(() => {
    const clips: Array<{ id: string; name: string; path: string; startOffset: number; duration: number; sourceStart: number; speedMultiplier: number }> = [];
    for (const track of state.tracks) {
      if (track.type !== 'video') continue;
      for (const clip of track.clips) {
        clips.push({ id: clip.id, name: clip.name, path: clip.path, startOffset: clip.startOffset, duration: clip.duration, sourceStart: clip.sourceStart, speedMultiplier: clip.speedMultiplier });
      }
    }
    return clips.sort((a, b) => a.startOffset - b.startOffset);
  }, [state.tracks]);

  const handleAutoExtractAll = useCallback(async () => {
    if (!window.electronAPI?.transcribeVideo) {
      setTranscribeError('Transcription not available.');
      return;
    }
    if (videoClips.length === 0) return;

    setTranscribing(true);
    setTranscribeProgress({ stage: 'Starting...', progress: 0 });
    setTranscribeError(null);

    if (cleanupRef.current) cleanupRef.current();
    cleanupRef.current = window.electronAPI.onTranscribeProgress((data) => {
      setTranscribeProgress(data);
    });

    const allSubs: SubtitleItem[] = [];
    const style = { ...state.globalSubtitleStyle };
    let errorMsg: string | null = null;

    try {
      for (let i = 0; i < videoClips.length; i++) {
        const clip = videoClips[i];
        setTranscribeProgress({
          stage: `Clip ${i + 1}/${videoClips.length}: ${clip.name.replace(/\.[^.]+$/, '')}`,
          progress: i / videoClips.length,
        });

        const result = await window.electronAPI.transcribeVideo(
          clip.path, clip.startOffset, clip.sourceStart,
          clip.duration, clip.speedMultiplier,
        );
        if (!result.success) {
          errorMsg = `Failed on "${clip.name}": ${result.error}`;
          break;
        }
        if (result.subtitles) {
          for (const s of result.subtitles) {
            allSubs.push({
              id: Math.random().toString(36).substr(2, 12),
              text: s.text,
              startTime: s.startTime,
              endTime: s.endTime,
              style: { ...style },
            });
          }
        }
      }

      if (errorMsg) {
        setTranscribeError(errorMsg);
      } else if (allSubs.length > 0) {
        // Clear old subtitles before adding new ones to avoid duplication
        clearAllSubtitles();
        addSubtitlesBatch(allSubs);
      } else {
        setTranscribeError('No speech detected in any clip.');
      }
    } catch (err: any) {
      setTranscribeError(err.message || 'Transcription failed.');
    } finally {
      setTranscribing(false);
      setTranscribeProgress(null);
      if (cleanupRef.current) { cleanupRef.current(); cleanupRef.current = null; }
    }
  }, [videoClips, state.globalSubtitleStyle, addSubtitlesBatch, clearAllSubtitles]);

  useEffect(() => {
    return () => { if (cleanupRef.current) cleanupRef.current(); };
  }, []);

  const handleApplyPreset = useCallback((presetId: SubtitlePresetId) => {
    const preset = PRESETS.find(p => p.id === presetId);
    if (preset) applyGlobalStyleToAll({ ...preset.style });
  }, [applyGlobalStyleToAll]);

  const updateGlobal = useCallback((updates: Partial<SubtitleStyle>) => {
    applyGlobalStyleToAll(updates);
  }, [applyGlobalStyleToAll]);

  const sortedSubs = useMemo(() =>
    [...state.subtitles].sort((a, b) => a.startTime - b.startTime),
    [state.subtitles]
  );

  return (
    <div className="subtitle-editor">
      {/* Auto-Extract */}
      <div className="se-section">
        <div className="se-section-header">
          <h3><Wand2 size={14} /> Auto-Generate Subtitles</h3>
        </div>

        {videoClips.length === 0 ? (
          <div className="se-empty">Add video clips to the timeline first</div>
        ) : transcribing ? (
          <div className="se-progress">
            <Loader2 size={16} className="animate-spin" />
            <div className="se-progress-info">
              <span className="se-progress-stage">{transcribeProgress?.stage || 'Processing...'}</span>
              <div className="progress-bar-track">
                <div className="progress-bar-fill" style={{ width: `${(transcribeProgress?.progress ?? 0) * 100}%` }} />
              </div>
            </div>
          </div>
        ) : (
          <button className="se-extract-btn" onClick={handleAutoExtractAll}>
            <Mic size={14} />
            Extract from all clips ({videoClips.length} clip{videoClips.length !== 1 ? 's' : ''})
          </button>
        )}

        {transcribeError && <div className="se-error">{transcribeError}</div>}
      </div>

      {/* Style Presets */}
      <div className="se-section">
        <h4 className="se-label">Style Presets</h4>
        <div className="se-presets-grid">
          {PRESETS.map(preset => (
            <PresetCard
              key={preset.id}
              preset={preset}
              active={activePresetId === preset.id}
              onSelect={() => handleApplyPreset(preset.id)}
            />
          ))}
        </div>
      </div>

      {/* Global Style Controls */}
      <div className="se-section">
        <h4 className="se-label">Style (all subtitles)</h4>

        <div className="se-field">
          <label><Bold size={11} /> Font</label>
          <select className="se-select" value={gs.fontFamily} onChange={e => updateGlobal({ fontFamily: e.target.value as SubtitleFontFamily })}>
            {FONT_OPTIONS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
        </div>

        <div className="se-row">
          <div className="se-field half">
            <label>Size</label>
            <div className="se-range-row">
              <input type="range" className="se-range" value={gs.fontSize} onChange={e => updateGlobal({ fontSize: Number(e.target.value) })} min={16} max={120} />
              <span className="se-range-val">{gs.fontSize}</span>
            </div>
          </div>
          <div className="se-field half">
            <label>Weight</label>
            <select className="se-select" value={gs.fontWeight} onChange={e => updateGlobal({ fontWeight: Number(e.target.value) })}>
              <option value={400}>Regular</option>
              <option value={600}>Semi Bold</option>
              <option value={700}>Bold</option>
              <option value={800}>Extra Bold</option>
              <option value={900}>Black</option>
            </select>
          </div>
        </div>

        <div className="se-row">
          <div className="se-field half">
            <label><Palette size={11} /> Color</label>
            <input type="color" className="se-color" value={gs.color} onChange={e => updateGlobal({ color: e.target.value })} />
          </div>
          <div className="se-field half">
            <label>Outline</label>
            <div className="se-color-outline">
              <input type="color" className="se-color" value={gs.strokeColor === 'transparent' ? '#000000' : gs.strokeColor} onChange={e => updateGlobal({ strokeColor: e.target.value })} />
              <input type="range" className="se-range" value={gs.strokeWidth} onChange={e => updateGlobal({ strokeWidth: Number(e.target.value) })} min={0} max={8} step={0.5} />
            </div>
          </div>
        </div>

        <div className="se-row">
          <div className="se-field half">
            <label><AlignCenter size={11} /> Position</label>
            <div className="se-btn-group">
              {POSITION_OPTIONS.map(p => (
                <button key={p.value} className={`se-btn-group-item${gs.position === p.value ? ' active' : ''}`} onClick={() => updateGlobal({ position: p.value })}>{p.label}</button>
              ))}
            </div>
          </div>
          <div className="se-field half">
            <label>Animation</label>
            <select className="se-select" value={gs.animation} onChange={e => updateGlobal({ animation: e.target.value as SubtitleAnimation })}>
              {ANIMATION_OPTIONS.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
            </select>
          </div>
        </div>

        <label className="se-checkbox">
          <input type="checkbox" checked={gs.uppercase} onChange={e => updateGlobal({ uppercase: e.target.checked })} />
          UPPERCASE
        </label>

        <button className="se-advanced-toggle" onClick={() => setShowAdvanced(!showAdvanced)}>
          {showAdvanced ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          Advanced
        </button>

        {showAdvanced && (
          <div className="se-advanced">
            <div className="se-field">
              <label>Background</label>
              <div className="se-color-outline">
                <input type="color" className="se-color"
                  value={gs.backgroundColor === 'transparent' ? '#000000' : '#000000'}
                  onChange={e => {
                    const h = e.target.value;
                    const r = parseInt(h.slice(1,3),16), g2 = parseInt(h.slice(3,5),16), b = parseInt(h.slice(5,7),16);
                    updateGlobal({ backgroundColor: `rgba(${r},${g2},${b},0.65)` });
                  }}
                />
                <button className="se-btn-xs" onClick={() => updateGlobal({ backgroundColor: 'transparent' })}>None</button>
              </div>
            </div>
            <div className="se-row">
              <div className="se-field half">
                <label>Letter Spacing</label>
                <div className="se-range-row">
                  <input type="range" className="se-range" value={gs.letterSpacing} onChange={e => updateGlobal({ letterSpacing: Number(e.target.value) })} min={0} max={10} step={0.5} />
                  <span className="se-range-val">{gs.letterSpacing}</span>
                </div>
              </div>
              <div className="se-field half">
                <label>Line Height</label>
                <div className="se-range-row">
                  <input type="range" className="se-range" value={gs.lineHeight} onChange={e => updateGlobal({ lineHeight: Number(e.target.value) })} min={0.8} max={2} step={0.1} />
                  <span className="se-range-val">{gs.lineHeight.toFixed(1)}</span>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Subtitle List */}
      {sortedSubs.length > 0 && (
        <div className="se-section">
          <div className="se-section-header">
            <h4 className="se-label">
              <Type size={11} /> Subtitles
              <span className="se-count">{sortedSubs.length}</span>
            </h4>
            <button className="se-btn-xs danger" onClick={clearAllSubtitles} title="Remove all subtitles">
              <Trash2 size={11} /> Clear
            </button>
          </div>
          <div className="se-subtitle-list">
            {sortedSubs.map(sub => (
              <div
                key={sub.id}
                className={`se-sub-item${state.selectedSubtitleId === sub.id ? ' selected' : ''}`}
                onClick={() => { selectSubtitle(sub.id); setCursorPosition(sub.startTime + 0.05); }}
              >
                <span className="se-sub-text">{sub.text || '(empty)'}</span>
                <span className="se-sub-time">{formatTime(sub.startTime)}</span>
                <button className="se-sub-del" onClick={e => { e.stopPropagation(); removeSubtitle(sub.id); }} title="Delete">
                  <Trash2 size={10} />
                </button>
              </div>
            ))}
          </div>
          <p className="se-hint">Click a subtitle on the timeline to edit text and position</p>
        </div>
      )}
    </div>
  );
};

export default SubtitleEditor;
