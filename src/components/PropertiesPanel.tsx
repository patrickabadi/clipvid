import { Clock, Gauge, Sparkles, Trash2, Volume2, X } from 'lucide-react';
import React from 'react';
import { useTimelineContext } from '../lib/TimelineContext';
import { TransitionType } from '../lib/types';

const TRANSITION_LABELS: Record<TransitionType, string> = {
  'fade': 'Fade',
  'dissolve': 'Dissolve',
  'flash': 'Flash',
  'wipe-left': 'Wipe Left',
  'wipe-right': 'Wipe Right',
  'slide-left': 'Slide Left',
  'slide-right': 'Slide Right',
  'zoom': 'Zoom',
  'blur': 'Blur',
};
const ALL_TRANSITION_TYPES = Object.keys(TRANSITION_LABELS) as TransitionType[];

const PropertiesPanel: React.FC = () => {
  const { state, updateClip, selectClip, selectTransition, updateTransition, removeTransition, pushUndo } = useTimelineContext();

  /* ── Transition selection ── */
  const selectedTransition = (() => {
    if (!state.selectedTransitionClipId) return null;
    for (const t of state.tracks) {
      const c = t.clips.find(c => c.id === state.selectedTransitionClipId);
      if (c?.transition) return { clip: c, trackId: t.id, transition: c.transition };
    }
    return null;
  })();

  /* ── Clip selection ── */
  const selected = (() => {
    if (selectedTransition) return null;
    for (const t of state.tracks) {
      const c = t.clips.find(c => c.id === state.selectedClipId);
      if (c) return { clip: c, trackId: t.id };
    }
    return null;
  })();

  /* ─── Transition Properties ─── */
  if (selectedTransition) {
    const { clip, trackId, transition } = selectedTransition;

    const handleDuration = (d: number) => {
      pushUndo();
      updateTransition(trackId, clip.id, { duration: Math.max(0.1, Math.min(3, d)) });
    };

    const handleTypeChange = (type: TransitionType) => {
      pushUndo();
      updateTransition(trackId, clip.id, { type });
    };

    return (
      <aside className="properties-panel">
        <div className="properties-header">
          <h3>Transition</h3>
          <button className="properties-close" onClick={() => selectTransition(null)} title="Close">
            <X size={16} />
          </button>
        </div>
        <div className="properties-body">
          <div className="prop-section">
            <label className="prop-label"><Sparkles size={14} /> Type</label>
            <div className="prop-transition-types">
              {ALL_TRANSITION_TYPES.map(t => (
                <button
                  key={t}
                  className={`transition-type-btn ${transition.type === t ? 'active' : ''}`}
                  onClick={() => handleTypeChange(t)}
                >
                  {TRANSITION_LABELS[t]}
                </button>
              ))}
            </div>
          </div>

          <div className="prop-divider" />

          <div className="prop-section">
            <label className="prop-label"><Clock size={14} /> Duration</label>
            <div className="prop-slider-row">
              <input
                type="range"
                min={10}
                max={300}
                step={5}
                value={Math.round(transition.duration * 100)}
                onChange={e => handleDuration(parseInt(e.target.value) / 100)}
                className="prop-slider"
              />
              <span className="prop-slider-value">{transition.duration.toFixed(1)}s</span>
            </div>
          </div>

          <div className="prop-divider" />

          <button
            className="prop-delete-btn"
            onClick={() => removeTransition(trackId, clip.id)}
          >
            <Trash2 size={14} /> Remove Transition
          </button>
        </div>
      </aside>
    );
  }

  /* ─── Clip Properties ─── */
  if (!selected) return null;
  const { clip, trackId } = selected;

  const fmtDur = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = (s % 60).toFixed(1);
    return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
  };

  const handleVolume = (v: number) => {
    pushUndo();
    updateClip(trackId, clip.id, { volume: v });
  };

  const handleSpeed = (newSpeed: number) => {
    pushUndo();
    // Adjust timeline duration so the same source material plays at the new speed
    const sourceDuration = clip.duration * clip.speedMultiplier;
    const newDuration = sourceDuration / newSpeed;
    updateClip(trackId, clip.id, { speedMultiplier: newSpeed, duration: newDuration });
  };

  // Strip extension and UUID from name for display
  let displayName = clip.name.replace(/\.[^.]+$/, '');
  displayName = displayName.replace(/_?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '');
  displayName = displayName.replace(/[_-]+$/, '') || clip.name;

  return (
    <aside className="properties-panel">
      <div className="properties-header">
        <h3>Properties</h3>
        <button className="properties-close" onClick={() => selectClip(null)} title="Close">
          <X size={16} />
        </button>
      </div>

      <div className="properties-body">
        {/* Thumbnail preview */}
        {clip.thumbnail && (
          <div className="prop-thumbnail">
            <img src={clip.thumbnail} alt="Clip thumbnail" />
          </div>
        )}

        <div className="prop-section">
          <label className="prop-label">Clip</label>
          <span className="prop-value clip-name-value">{displayName}</span>
        </div>

        <div className="prop-section">
          <label className="prop-label">Type</label>
          <span className="prop-value prop-badge">{clip.type}</span>
        </div>

        <div className="prop-section">
          <label className="prop-label">Duration</label>
          <span className="prop-value">{fmtDur(clip.duration)}</span>
        </div>

        <div className="prop-section">
          <label className="prop-label">Position</label>
          <span className="prop-value">{fmtDur(clip.startOffset)}</span>
        </div>

        <div className="prop-section">
          <label className="prop-label">Source Range</label>
          <span className="prop-value">{fmtDur(clip.sourceStart)} &mdash; {fmtDur(clip.sourceStart + clip.duration * clip.speedMultiplier)}</span>
        </div>

        <div className="prop-divider" />

        <div className="prop-section">
          <label className="prop-label"><Volume2 size={14} /> Volume</label>
          <div className="prop-slider-row">
            <input
              type="range"
              min={0}
              max={200}
              value={Math.round(clip.volume * 100)}
              onChange={e => handleVolume(parseInt(e.target.value) / 100)}
              className="prop-slider"
            />
            <span className="prop-slider-value">{Math.round(clip.volume * 100)}%</span>
          </div>
        </div>

        <div className="prop-section">
          <label className="prop-label"><Gauge size={14} /> Speed</label>
          <div className="prop-speed-buttons">
            {[0.25, 0.5, 1, 1.5, 2, 4].map(s => (
              <button
                key={s}
                className={`speed-btn ${clip.speedMultiplier === s ? 'active' : ''}`}
                onClick={() => handleSpeed(s)}
              >
                {s}x
              </button>
            ))}
          </div>
        </div>
      </div>
    </aside>
  );
};

export default PropertiesPanel;
