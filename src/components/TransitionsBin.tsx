import {
  ArrowLeft, ArrowRight, Disc, Maximize, MoveLeft, MoveRight,
  Sparkles, Sun, Zap,
} from 'lucide-react';
import React from 'react';
import { TransitionType } from '../lib/types';

const TRANSITION_CATALOG: { type: TransitionType; label: string; icon: React.ReactNode; desc: string }[] = [
  { type: 'fade',        label: 'Fade',          icon: <Disc size={18} />,       desc: 'Dip to black' },
  { type: 'dissolve',    label: 'Dissolve',      icon: <Sparkles size={18} />,   desc: 'Soft cross dissolve' },
  { type: 'flash',       label: 'Flash',         icon: <Zap size={18} />,        desc: 'Flash to white' },
  { type: 'wipe-left',   label: 'Wipe Left',     icon: <ArrowRight size={18} />, desc: 'Wipe from left' },
  { type: 'wipe-right',  label: 'Wipe Right',    icon: <ArrowLeft size={18} />,  desc: 'Wipe from right' },
  { type: 'slide-left',  label: 'Slide Left',    icon: <MoveLeft size={18} />,   desc: 'Slide in from right' },
  { type: 'slide-right', label: 'Slide Right',   icon: <MoveRight size={18} />,  desc: 'Slide in from left' },
  { type: 'zoom',        label: 'Zoom',          icon: <Maximize size={18} />,   desc: 'Zoom in/out' },
  { type: 'blur',        label: 'Blur',          icon: <Sun size={18} />,        desc: 'Blur transition' },
];

const TransitionsBin: React.FC = () => {
  return (
    <div className="transitions-bin">
      <div className="sidebar-section-header">
        <h3>Transitions</h3>
        <span className="media-count">{TRANSITION_CATALOG.length} effects</span>
      </div>

      <p className="transitions-hint">
        Drag a transition onto the boundary between two clips, or click the <strong>+</strong> button between clips on the timeline.
      </p>

      <div className="transitions-grid">
        {TRANSITION_CATALOG.map(t => (
          <div
            key={t.type}
            className="transition-card"
            draggable
            onDragStart={e => {
              e.dataTransfer.setData('transition-type', t.type);
              e.dataTransfer.effectAllowed = 'copy';
            }}
            title={t.desc}
          >
            <div className="transition-card-icon">{t.icon}</div>
            <span className="transition-card-label">{t.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

export default TransitionsBin;
