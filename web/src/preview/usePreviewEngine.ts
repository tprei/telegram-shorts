import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { LayoutProfile } from '@domain/layout.js';
import type { Timeline } from '@domain/timeline.js';
import { PreviewEngine } from './PreviewEngine.js';
import type { PreviewEngineOptions, PreviewState } from './PreviewEngine.js';

const INITIAL_STATE: PreviewState = {
  ready: false,
  playing: false,
  buffering: false,
  outputSeconds: 0,
  durationSeconds: 0,
  error: null,
};

export function usePreviewEngine(input: {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  options: Omit<PreviewEngineOptions, 'canvas'> | null;
  timeline: Timeline | null;
  layout: LayoutProfile | null;
}): PreviewState & { play(): void; pause(): void; toggle(): void; seek(seconds: number): void } {
  const { canvasRef, options, timeline, layout } = input;
  const engineRef = useRef<PreviewEngine | null>(null);
  const timelineRef = useRef(timeline);
  const layoutRef = useRef(layout);
  timelineRef.current = timeline;
  layoutRef.current = layout;
  const [state, setState] = useState<PreviewState>(INITIAL_STATE);

  const videoUrl = options === null ? null : options.videoUrl;
  const fontUrl = options === null ? null : options.fontUrl;
  const fontFamily = options === null ? null : options.fontFamily;
  const thumbnailUrl = options === null ? null : options.thumbnailUrl;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || videoUrl === null || fontUrl === null || fontFamily === null) {
      return;
    }
    const engine = new PreviewEngine({ canvas, videoUrl, fontUrl, fontFamily, thumbnailUrl });
    engineRef.current = engine;
    const unsubscribe = engine.subscribe(setState);
    setState(engine.getState());
    const currentTimeline = timelineRef.current;
    const currentLayout = layoutRef.current;
    if (currentTimeline !== null && currentLayout !== null) {
      engine.setTimeline(currentTimeline, currentLayout);
    }
    void engine.load();
    return () => {
      unsubscribe();
      engine.destroy();
      engineRef.current = null;
    };
  }, [canvasRef, videoUrl, fontUrl, fontFamily, thumbnailUrl]);

  useEffect(() => {
    const engine = engineRef.current;
    if (engine === null || timeline === null || layout === null) {
      return;
    }
    engine.setTimeline(timeline, layout);
  }, [timeline, layout]);

  const play = useCallback(() => {
    void engineRef.current?.play();
  }, []);
  const pause = useCallback(() => {
    engineRef.current?.pause();
  }, []);
  const toggle = useCallback(() => {
    engineRef.current?.toggle();
  }, []);
  const seek = useCallback((seconds: number) => {
    engineRef.current?.seek(seconds);
  }, []);

  return { ...state, play, pause, toggle, seek };
}
