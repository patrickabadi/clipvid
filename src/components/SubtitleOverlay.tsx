import React, { useCallback, useMemo, useRef } from 'react';
import { useTimelineContext } from '../lib/TimelineContext';
import { SubtitleItem } from '../lib/types';

/* --- Compute container styles for a subtitle (no entrance animation) --- */

function subtitleContainerCSS(sub: SubtitleItem, progress: number): React.CSSProperties {
  const s = sub.style;

  const shadows: string[] = [];
  if (s.strokeWidth > 0 && s.strokeColor !== 'transparent') {
    const w = s.strokeWidth;
    for (let angle = 0; angle < 360; angle += 30) {
      const rad = (angle * Math.PI) / 180;
      const x = Math.cos(rad) * w;
      const y = Math.sin(rad) * w;
      shadows.push(`${x.toFixed(1)}px ${y.toFixed(1)}px 0 ${s.strokeColor}`);
    }
    shadows.push(`0 0 ${w * 2}px ${s.strokeColor}`);
  }

  // Exit fade (last 15% of duration)
  let opacity = 1;
  const exitStart = 0.85;
  if (progress > exitStart) {
    const exitT = (progress - exitStart) / (1 - exitStart);
    opacity = 1 - exitT;
  }

  return {
    fontFamily: `'${s.fontFamily}', sans-serif`,
    fontSize: `${s.fontSize}px`,
    fontWeight: s.fontWeight,
    color: s.color,
    textTransform: s.uppercase ? 'uppercase' : 'none',
    letterSpacing: `${s.letterSpacing}px`,
    lineHeight: s.lineHeight,
    textShadow: shadows.length > 0 ? shadows.join(', ') : undefined,
    background: s.backgroundColor !== 'transparent' ? s.backgroundColor : undefined,
    padding: s.backgroundColor !== 'transparent'
      ? `${s.backgroundPadding}px ${s.backgroundPadding * 1.5}px`
      : undefined,
    borderRadius: s.backgroundColor !== 'transparent'
      ? `${s.backgroundRadius}px`
      : undefined,
    opacity,
    transition: 'transform 0.05s ease-out',
    textAlign: 'center' as const,
    width: `${s.maxWidth || 90}%`,
    wordBreak: 'break-word' as const,
  };
}

/* --- Per-word animated text --- */

function WordByWordText({ text, progress, animation, highlightColor }: {
  text: string;
  progress: number;
  animation: string;
  highlightColor: string;
}) {
  // Split preserving spaces: ["word", " ", "word", " ", "word"]
  const tokens = text.split(/(\s+)/);

  // Build word-index mapping (skip whitespace tokens)
  const wordIndices: number[] = []; // for each token, its word index or -1 for spaces
  let wordCount = 0;
  for (const tok of tokens) {
    if (tok.trim().length > 0) {
      wordIndices.push(wordCount);
      wordCount++;
    } else {
      wordIndices.push(-1);
    }
  }

  if (wordCount === 0) return <>{text}</>;

  // No animation → show all immediately
  if (animation === 'none') return <>{text}</>;

  // Use first 70% of progress to reveal all words, last 30% all stay visible
  const revealEnd = 0.70;
  const revealProgress = Math.min(1, progress / revealEnd);

  // Weight words by character length for natural pacing
  // Short words (a, I, is) breeze by; longer words get a bit more time
  const wordLengths: number[] = [];
  for (const tok of tokens) {
    if (tok.trim().length > 0) wordLengths.push(tok.trim().length);
  }
  const totalLen = wordLengths.reduce((a, b) => a + b, 0);
  const avgLen = totalLen / wordCount;

  // Weighted start time for each word
  const wordStarts: number[] = [];
  let cumWeight = 0;
  const weights: number[] = wordLengths.map(l =>
    Math.max(0.4, 0.5 + 0.5 * (l / avgLen))
  );
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  for (let i = 0; i < wordCount; i++) {
    wordStarts.push(cumWeight / totalWeight);
    cumWeight += weights[i];
  }

  // Find the most-recently-revealed word
  let activeWordIdx = -1;
  for (let i = wordCount - 1; i >= 0; i--) {
    if (revealProgress >= wordStarts[i]) {
      activeWordIdx = i;
      break;
    }
  }

  // Per-word entrance takes ~12% of reveal time (clamped)
  const wordAnimFrac = Math.min(0.15, 1.2 / wordCount);

  return (
    <>
      {tokens.map((token, tIdx) => {
        const wIdx = wordIndices[tIdx];

        // Whitespace: always render as-is
        if (wIdx === -1) return <span key={tIdx}>{token}</span>;

        // Word not yet reached
        if (revealProgress < wordStarts[wIdx]) {
          return (
            <span key={tIdx} style={{ opacity: 0, display: 'inline-block' }}>
              {token}
            </span>
          );
        }

        // How far through this word's entrance animation (0→1)
        const localT = Math.min(1, (revealProgress - wordStarts[wIdx]) / wordAnimFrac);
        const isAnimating = localT < 1;
        const isCurrentWord = wIdx === activeWordIdx;

        let wordTransform = '';
        let wordOpacity = 1;

        if (isAnimating) {
          switch (animation) {
            case 'pop': default: {
              const scale = localT < 0.55
                ? 0.3 + (localT / 0.55) * 0.9
                : 1.2 - ((localT - 0.55) / 0.45) * 0.2;
              wordTransform = `scale(${scale})`;
              wordOpacity = Math.min(1, localT * 4);
              break;
            }
            case 'fade': {
              wordOpacity = localT;
              break;
            }
            case 'bounce': {
              const b = Math.abs(Math.sin(localT * Math.PI * 1.5)) * (1 - localT) * 10;
              wordTransform = `translateY(${-b}px)`;
              wordOpacity = Math.min(1, localT * 4);
              break;
            }
            case 'slide-up': {
              wordTransform = `translateY(${(1 - localT) * 14}px)`;
              wordOpacity = localT;
              break;
            }
            case 'typewriter': {
              // Per-word instant reveal (typewriter is already word-level now)
              wordOpacity = 1;
              break;
            }
          }
        }

        return (
          <span
            key={tIdx}
            style={{
              display: 'inline-block',
              opacity: wordOpacity,
              transform: wordTransform || undefined,
              color: isCurrentWord ? highlightColor : undefined,
              transition: isCurrentWord ? undefined : 'color 0.3s ease',
            }}
          >
            {token}
          </span>
        );
      })}
    </>
  );
}

/* --- Single draggable subtitle --- */

const DraggableSubtitle: React.FC<{
  sub: SubtitleItem;
  cursor: number;
  isSelected: boolean;
  onSelect: (id: string) => void;
  onMove: (id: string, x: number, y: number) => void;
  onResize: (id: string, maxWidth: number) => void;
}> = ({ sub, cursor, isSelected, onSelect, onMove, onResize }) => {
  const totalDuration = sub.endTime - sub.startTime;
  const elapsed = cursor - sub.startTime;
  const progress = Math.max(0, Math.min(1, elapsed / totalDuration));
  const style = subtitleContainerCSS(sub, progress);

  const elRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const dragStart = useRef({ mx: 0, my: 0, ox: 0, oy: 0 });

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    onSelect(sub.id);
    dragging.current = true;
    const containerRect = (e.currentTarget as HTMLElement).parentElement!.getBoundingClientRect();
    dragStart.current = {
      mx: e.clientX,
      my: e.clientY,
      ox: sub.style.customX ?? 50,
      oy: sub.style.customY ?? (sub.style.position === 'top' ? 8 : sub.style.position === 'center' ? 50 : 85),
    };
    const containerW = containerRect.width;
    const containerH = containerRect.height;

    const onPointerMove = (ev: PointerEvent) => {
      if (!dragging.current) return;
      const dx = ev.clientX - dragStart.current.mx;
      const dy = ev.clientY - dragStart.current.my;
      const newX = Math.max(0, Math.min(100, dragStart.current.ox + (dx / containerW) * 100));
      const newY = Math.max(0, Math.min(100, dragStart.current.oy + (dy / containerH) * 100));
      onMove(sub.id, newX, newY);
    };

    const onPointerUp = () => {
      dragging.current = false;
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
    };

    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
  }, [sub.id, sub.style.customX, sub.style.customY, sub.style.position, onSelect, onMove]);

  // Resize handle: drag left or right edge to change maxWidth
  const handleResizePointerDown = useCallback((e: React.PointerEvent, side: 'left' | 'right') => {
    e.stopPropagation();
    e.preventDefault();
    const containerRect = (e.currentTarget as HTMLElement).closest('.subtitle-overlay')!.getBoundingClientRect();
    const startX = e.clientX;
    const startWidth = sub.style.maxWidth || 90;

    const onPointerMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dPct = (dx / containerRect.width) * 100;
      // Dragging right handle right = wider, left handle left = wider
      const delta = side === 'right' ? dPct * 2 : -dPct * 2;
      const newWidth = Math.max(15, Math.min(100, startWidth + delta));
      onResize(sub.id, Math.round(newWidth));
    };

    const onPointerUp = () => {
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
    };

    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
  }, [sub.id, sub.style.maxWidth, onResize]);

  // Position: use customX/Y if set, otherwise fall back to position preset
  const hasCustomPos = sub.style.customX != null && sub.style.customY != null;
  const posX = hasCustomPos ? sub.style.customX! : 50;
  const posY = hasCustomPos ? sub.style.customY! : (sub.style.position === 'top' ? 8 : sub.style.position === 'center' ? 50 : 85);

  // Force selected subtitle to be fully visible (animation may start at opacity 0)
  const finalOpacity = isSelected ? 1 : style.opacity;

  return (
    <div
      ref={elRef}
      className={`subtitle-draggable${isSelected ? ' subtitle-selected' : ''}`}
      style={{
        ...style,
        opacity: finalOpacity,
        position: 'absolute',
        left: `${posX}%`,
        top: `${posY}%`,
        transform: `translate(-50%, -50%) ${style.transform || ''}`.trim(),
        cursor: 'grab',
        pointerEvents: 'auto',
        userSelect: 'none',
      }}
      onPointerDown={handlePointerDown}
    >
      {isSelected && (
        <>
          <div
            className="subtitle-resize-handle left"
            onPointerDown={(e) => handleResizePointerDown(e, 'left')}
          />
          <div
            className="subtitle-resize-handle right"
            onPointerDown={(e) => handleResizePointerDown(e, 'right')}
          />
        </>
      )}
      <WordByWordText
        text={sub.text}
        progress={progress}
        animation={sub.style.animation}
        highlightColor={sub.style.highlightColor}
      />
    </div>
  );
};

/* --- Main overlay --- */

const SubtitleOverlay: React.FC = () => {
  const { state, selectSubtitle, updateSubtitleStyle } = useTimelineContext();
  const { subtitles, cursorPosition } = state;

  const activeSubtitles = useMemo(() =>
    subtitles.filter(s => cursorPosition >= s.startTime && cursorPosition < s.endTime),
    [subtitles, cursorPosition]
  );

  const handleMove = useCallback((id: string, x: number, y: number) => {
    updateSubtitleStyle(id, { customX: x, customY: y });
  }, [updateSubtitleStyle]);

  const handleResize = useCallback((id: string, maxWidth: number) => {
    updateSubtitleStyle(id, { maxWidth });
  }, [updateSubtitleStyle]);

  const handleSelect = useCallback((id: string) => {
    selectSubtitle(id);
  }, [selectSubtitle]);

  // Always render the container div even when empty (for consistent hooks)
  return (
    <div className="subtitle-overlay" onClick={() => selectSubtitle(null)}>
      {activeSubtitles.map(sub => (
        <DraggableSubtitle
          key={sub.id}
          sub={sub}
          cursor={cursorPosition}
          isSelected={state.selectedSubtitleId === sub.id}
          onSelect={handleSelect}
          onMove={handleMove}
          onResize={handleResize}
        />
      ))}
    </div>
  );
};

export default SubtitleOverlay;
