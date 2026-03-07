import { createContext, ReactNode, useContext } from 'react';
import { useTimeline } from '../hooks/useTimeline';

const TimelineContext = createContext<ReturnType<typeof useTimeline> | null>(null);

export const TimelineProvider = ({ children }: { children: ReactNode }) => {
  const timeline = useTimeline();
  return (
    <TimelineContext.Provider value={timeline}>
      {children}
    </TimelineContext.Provider>
  );
};

export const useTimelineContext = () => {
  const context = useContext(TimelineContext);
  if (!context) throw new Error("Must be used within TimelineProvider");
  return context;
};
