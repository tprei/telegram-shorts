import type { LayoutProfile } from '@domain/layout.js';
import type { Timeline, TimelineClip, TimelineEndCard } from '@domain/timeline.js';
import { activeCueAt, endCardAudioGain, outputToSource } from '@domain/timeline.js';
import { drawTimelineFrame } from './draw.js';

export interface PreviewEngineOptions {
  canvas: HTMLCanvasElement;
  videoUrl: string;
  fontUrl: string;
  fontFamily: string;
  thumbnailUrl: string | null;
}

export interface PreviewState {
  ready: boolean;
  playing: boolean;
  buffering: boolean;
  outputSeconds: number;
  durationSeconds: number;
  error: string | null;
}

const NOTIFY_INTERVAL_MS = 100;
const CUT_MARGIN_SECONDS = 0.01;
const END_CARD_SEEK_BACK_SECONDS = 0.05;
const END_CARD_AUDIO_SEEK_TOLERANCE_SECONDS = 0.04;

export class PreviewEngine {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly options: PreviewEngineOptions;
  private readonly videos: [HTMLVideoElement, HTMLVideoElement];
  private readonly listeners = new Set<(state: PreviewState) => void>();
  private state: PreviewState = {
    ready: false,
    playing: false,
    buffering: false,
    outputSeconds: 0,
    durationSeconds: 0,
    error: null,
  };
  private timeline: Timeline | null = null;
  private layout: LayoutProfile | null = null;
  private activeIndex: 0 | 1 = 0;
  private clipIndex = 0;
  private rafId = 0;
  private vfcGeneration = 0;
  private lastNotifyAt = 0;
  private metadataReady = false;
  private pendingMetadata = false;
  private pendingPlay = false;
  private pendingSwap = false;
  private endCardVisible = false;
  private endCardStartedAt: number | null = null;
  private endCardElapsed = 0;
  private thumbnail: HTMLImageElement | null = null;

  constructor(options: PreviewEngineOptions) {
    this.options = options;
    this.canvas = options.canvas;
    const ctx = options.canvas.getContext('2d');
    if (ctx === null) {
      throw new Error('Canvas 2D context is unavailable.');
    }
    this.ctx = ctx;
    this.videos = [this.createVideo(), this.createVideo()];
    for (const video of this.videos) {
      this.attachListeners(video);
    }
  }

  async load(): Promise<void> {
    const font = new FontFace(this.options.fontFamily, `url(${this.options.fontUrl})`);
    document.fonts.add(font);
    try {
      await font.load();
    } catch (error) {
      this.fail(error);
      return;
    }
    if (this.options.thumbnailUrl !== null) {
      const image = new Image();
      image.src = this.options.thumbnailUrl;
      try {
        await image.decode();
        this.thumbnail = image;
      } catch {
        this.thumbnail = null;
      }
    }
    const active = this.activeVideo();
    if (active.readyState < 1 && active.error === null) {
      this.pendingMetadata = true;
      return;
    }
    this.onMetadata(active);
  }

  setTimeline(timeline: Timeline, layout: LayoutProfile): void {
    const resumeOutput = this.state.durationSeconds > 0 ? this.state.outputSeconds : 0;
    this.timeline = timeline;
    this.layout = layout;
    this.canvas.width = layout.canvas.width;
    this.canvas.height = layout.canvas.height;
    this.state.durationSeconds = timeline.durationSeconds;
    this.endCardVisible = false;
    this.endCardStartedAt = null;
    this.endCardElapsed = 0;
    this.stopEndCardAudio();
    for (const video of this.videos) {
      video.playbackRate = timeline.speed;
    }
    this.syncTo(resumeOutput);
    this.drawCurrentFrame();
    this.notify(true);
  }

  async play(): Promise<void> {
    if (this.state.playing) {
      return;
    }
    const timeline = this.timeline;
    if (timeline === null || !this.metadataReady || timeline.clips.length === 0) {
      this.pendingPlay = true;
      return;
    }
    if (this.endCardVisible && timeline.endCard !== null && this.endCardElapsed < timeline.endCard.durationSeconds) {
      this.state.playing = true;
      this.endCardStartedAt = performance.now();
      this.startEndCardAudio(this.endCardElapsed);
      this.notify(true);
      this.startLoop();
      return;
    }
    if (this.state.outputSeconds >= timeline.durationSeconds - 0.001) {
      this.endCardVisible = false;
      this.endCardElapsed = 0;
      this.syncTo(0);
    }
    this.state.playing = true;
    this.state.buffering = false;
    const active = this.activeVideo();
    active.muted = false;
    await this.playElement(active);
    if (this.state.playing) {
      this.notify(true);
      this.startLoop();
    }
  }

  pause(): void {
    this.pendingPlay = false;
    if (this.endCardStartedAt !== null) {
      this.endCardElapsed += (performance.now() - this.endCardStartedAt) / 1000;
      this.endCardStartedAt = null;
    }
    if (!this.state.playing) {
      return;
    }
    this.state.playing = false;
    for (const video of this.videos) {
      video.pause();
    }
    this.stopLoop();
    this.notify(true);
  }

  toggle(): void {
    if (this.state.playing) {
      this.pause();
    } else {
      void this.play();
    }
  }

  seek(outputSeconds: number): void {
    const timeline = this.timeline;
    if (timeline === null) {
      this.state.outputSeconds = Math.max(0, outputSeconds);
      this.notify(true);
      this.drawCurrentFrame();
      return;
    }
    const target = Math.max(0, outputSeconds);
    if (target >= timeline.durationSeconds && timeline.endCard !== null) {
      this.endCardVisible = true;
      this.endCardElapsed = 0;
      this.state.outputSeconds = timeline.durationSeconds;
      const last = timeline.clips.at(-1);
      if (last !== undefined) {
        this.clipIndex = last.index;
      }
      this.activeVideo().pause();
      if (this.state.playing) {
        this.endCardStartedAt = performance.now();
        this.startEndCardAudio(0);
      } else {
        this.endCardStartedAt = null;
        this.stopEndCardAudio();
      }
      if (this.metadataReady && last !== undefined) {
        this.activeVideo().currentTime = Math.max(last.sourceStart, last.sourceEnd - END_CARD_SEEK_BACK_SECONDS);
      }
      this.notify(true);
      this.drawCurrentFrame();
      return;
    }
    this.endCardVisible = false;
    this.endCardStartedAt = null;
    this.endCardElapsed = 0;
    this.stopEndCardAudio();
    this.syncTo(target);
    this.drawCurrentFrame();
  }

  getState(): PreviewState {
    return { ...this.state };
  }

  subscribe(listener: (state: PreviewState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  destroy(): void {
    this.pendingPlay = false;
    this.stopLoop();
    for (const video of this.videos) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
    this.listeners.clear();
  }

  private createVideo(): HTMLVideoElement {
    const video = document.createElement('video');
    video.src = this.options.videoUrl;
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    return video;
  }

  private attachListeners(video: HTMLVideoElement): void {
    video.addEventListener('loadedmetadata', () => {
      if (this.pendingMetadata && this.isActive(video)) {
        this.pendingMetadata = false;
        this.onMetadata(video);
      }
    });
    video.addEventListener('seeked', () => {
      if (this.isActive(video)) {
        this.drawCurrentFrame();
      } else {
        this.maybeCompleteSwap();
      }
    });
    video.addEventListener('canplay', () => {
      if (this.isActive(video)) {
        if (this.state.buffering) {
          this.state.buffering = false;
          this.notify(false);
        }
      } else {
        this.maybeCompleteSwap();
      }
    });
    video.addEventListener('waiting', () => {
      if (this.isActive(video) && this.state.playing) {
        this.state.buffering = true;
        this.notify(false);
      }
    });
    video.addEventListener('playing', () => {
      if (this.isActive(video) && this.state.buffering) {
        this.state.buffering = false;
        this.notify(false);
      }
    });
    video.addEventListener('ended', () => {
      if (!this.isActive(video) || !this.state.playing || this.timeline === null) {
        return;
      }
      const clip = this.timeline.clips.at(this.clipIndex);
      if (clip !== undefined) {
        this.advanceFrom(clip);
      }
    });
    video.addEventListener('error', () => {
      const mediaError = video.error;
      if (mediaError === null) {
        return;
      }
      this.fail(
        new Error(
          mediaError.message.length > 0 ? mediaError.message : `Video failed to load (code ${mediaError.code}).`,
        ),
      );
    });
  }

  private onMetadata(video: HTMLVideoElement): void {
    if (video.error !== null) {
      this.fail(
        new Error(
          video.error.message.length > 0 ? video.error.message : `Video failed to load (code ${video.error.code}).`,
        ),
      );
      return;
    }
    this.metadataReady = true;
    this.state.ready = true;
    this.syncTo(this.state.outputSeconds);
    this.notify(true);
    if (this.pendingPlay) {
      this.pendingPlay = false;
      void this.play();
    }
  }

  private isActive(video: HTMLVideoElement): boolean {
    return this.videos[this.activeIndex] === video;
  }

  private activeVideo(): HTMLVideoElement {
    return this.videos[this.activeIndex];
  }

  private standbyVideo(): HTMLVideoElement {
    return this.videos[this.activeIndex === 0 ? 1 : 0];
  }

  private async playElement(video: HTMLVideoElement): Promise<void> {
    try {
      await video.play();
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return;
      }
      this.fail(error);
    }
  }

  private fail(error: unknown): void {
    this.state.error = error instanceof Error ? error.message : String(error);
    this.state.playing = false;
    this.pendingMetadata = false;
    this.stopLoop();
    this.notify(true);
  }

  private syncTo(outputSeconds: number): void {
    const timeline = this.timeline;
    if (timeline === null || timeline.clips.length === 0) {
      this.state.outputSeconds = Math.max(0, outputSeconds);
      return;
    }
    const clamped = Math.min(Math.max(0, outputSeconds), Math.max(0, timeline.durationSeconds - 0.001));
    if (!this.metadataReady) {
      this.state.outputSeconds = clamped;
      return;
    }
    const position = outputToSource(timeline, clamped);
    this.clipIndex = position.clipIndex;
    this.state.outputSeconds = clamped;
    this.activeVideo().currentTime = position.sourceSeconds;
    this.armStandbyAfter(this.clipIndex);
    this.notify(true);
  }

  private armStandbyAfter(clipIndex: number): void {
    const timeline = this.timeline;
    if (timeline === null) {
      return;
    }
    let targetClip: TimelineClip | undefined;
    for (let index = clipIndex + 1; index < timeline.clips.length; index += 1) {
      const clip = timeline.clips.at(index);
      if (clip !== undefined && !clip.joinsPrevious) {
        targetClip = clip;
        break;
      }
    }
    if (targetClip === undefined) {
      const audio = timeline.endCard === null ? null : timeline.endCard.audio;
      if (audio !== null) {
        this.standbyVideo().currentTime = audio.sourceStart;
      }
      return;
    }
    this.standbyVideo().currentTime = targetClip.sourceStart;
  }

  private startLoop(): void {
    if (this.rafId !== 0) {
      return;
    }
    this.vfcGeneration += 1;
    this.scheduleFrameCallback();
    this.rafId = requestAnimationFrame(this.tick);
  }

  private stopLoop(): void {
    if (this.rafId !== 0) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    this.vfcGeneration += 1;
  }

  private scheduleFrameCallback(): void {
    if (!this.state.playing) {
      return;
    }
    const generation = this.vfcGeneration;
    const active = this.activeVideo();
    if (typeof active.requestVideoFrameCallback !== 'function') {
      return;
    }
    active.requestVideoFrameCallback(() => {
      if (!this.state.playing || generation !== this.vfcGeneration) {
        return;
      }
      this.drawCurrentFrame();
      this.scheduleFrameCallback();
    });
  }

  private tick = (): void => {
    this.rafId = 0;
    if (!this.state.playing || this.timeline === null) {
      return;
    }
    const timeline = this.timeline;
    if (this.endCardStartedAt !== null) {
      const elapsed = this.endCardElapsed + (performance.now() - this.endCardStartedAt) / 1000;
      if (timeline.endCard !== null && elapsed >= timeline.endCard.durationSeconds) {
        this.stopAtEnd();
        return;
      }
      if (timeline.endCard !== null) {
        this.updateEndCardAudio(timeline.endCard, elapsed);
      }
      this.notify(false);
      this.rafId = requestAnimationFrame(this.tick);
      return;
    }
    const clip = timeline.clips.at(this.clipIndex);
    if (clip === undefined) {
      this.state.playing = false;
      this.stopLoop();
      this.notify(true);
      return;
    }
    const active = this.activeVideo();
    if (active.currentTime >= clip.sourceEnd - CUT_MARGIN_SECONDS) {
      this.advanceFrom(clip);
    } else {
      const output = clip.outputStart + (active.currentTime - clip.sourceStart) / timeline.speed;
      this.state.outputSeconds = Math.min(Math.max(output, clip.outputStart), clip.outputEnd);
      this.drawCurrentFrame();
      this.notify(false);
    }
    if (this.state.playing) {
      this.rafId = requestAnimationFrame(this.tick);
    }
  };

  private advanceFrom(clip: TimelineClip): void {
    const timeline = this.timeline;
    if (timeline === null) {
      return;
    }
    const next = timeline.clips.at(clip.index + 1);
    if (next === undefined) {
      this.enterEndCardOrStop();
      return;
    }
    if (next.joinsPrevious) {
      this.clipIndex = next.index;
      this.state.outputSeconds = next.outputStart;
      return;
    }
    const standby = this.standbyVideo();
    if (standby.readyState >= 2 && !standby.seeking) {
      this.swapTo(standby, next);
    } else {
      this.pendingSwap = true;
      if (!this.state.buffering) {
        this.state.buffering = true;
        this.notify(true);
      }
      this.activeVideo().pause();
    }
  }

  private swapTo(standby: HTMLVideoElement, next: TimelineClip): void {
    const active = this.activeVideo();
    active.pause();
    active.muted = true;
    standby.muted = false;
    this.activeIndex = this.activeIndex === 0 ? 1 : 0;
    this.clipIndex = next.index;
    this.state.outputSeconds = next.outputStart;
    this.state.buffering = false;
    this.pendingSwap = false;
    this.vfcGeneration += 1;
    this.scheduleFrameCallback();
    void this.playElement(standby);
    this.armStandbyAfter(this.clipIndex);
    this.notify(true);
  }

  private maybeCompleteSwap(): void {
    if (!this.pendingSwap || !this.state.playing || this.timeline === null) {
      return;
    }
    const next = this.timeline.clips.at(this.clipIndex + 1);
    if (next === undefined) {
      return;
    }
    const standby = this.standbyVideo();
    if (standby.readyState >= 2 && !standby.seeking) {
      this.swapTo(standby, next);
    }
  }

  private enterEndCardOrStop(): void {
    const timeline = this.timeline;
    this.activeVideo().pause();
    if (timeline === null || timeline.endCard === null) {
      this.state.playing = false;
      if (timeline !== null) {
        this.state.outputSeconds = timeline.durationSeconds;
      }
      this.stopLoop();
      this.notify(true);
      this.drawCurrentFrame();
      return;
    }
    this.endCardVisible = true;
    this.endCardElapsed = 0;
    this.endCardStartedAt = performance.now();
    this.startEndCardAudio(0);
    this.state.outputSeconds = timeline.durationSeconds;
    this.drawCurrentFrame();
    this.notify(true);
  }

  private stopAtEnd(): void {
    this.endCardStartedAt = null;
    if (this.timeline !== null && this.timeline.endCard !== null) {
      this.endCardElapsed = this.timeline.endCard.durationSeconds;
    }
    this.state.playing = false;
    for (const video of this.videos) {
      video.pause();
    }
    this.stopEndCardAudio();
    this.stopLoop();
    this.notify(true);
  }

  private startEndCardAudio(elapsedSeconds: number): void {
    const timeline = this.timeline;
    if (timeline === null || timeline.endCard === null || timeline.endCard.audio === null) {
      return;
    }
    const audio = timeline.endCard.audio;
    const target = audio.sourceStart + elapsedSeconds * timeline.speed;
    if (target >= audio.sourceEnd) {
      return;
    }
    const standby = this.standbyVideo();
    if (Math.abs(standby.currentTime - target) > END_CARD_AUDIO_SEEK_TOLERANCE_SECONDS) {
      standby.currentTime = target;
    }
    standby.playbackRate = timeline.speed;
    standby.volume = endCardAudioGain(timeline.endCard, elapsedSeconds);
    standby.muted = false;
    void this.playElement(standby);
  }

  private updateEndCardAudio(endCard: TimelineEndCard, elapsedSeconds: number): void {
    const standby = this.standbyVideo();
    if (endCard.audio === null || standby.muted) {
      return;
    }
    if (standby.currentTime >= endCard.audio.sourceEnd) {
      standby.pause();
      return;
    }
    standby.volume = endCardAudioGain(endCard, elapsedSeconds);
  }

  private stopEndCardAudio(): void {
    const standby = this.standbyVideo();
    standby.pause();
    standby.muted = true;
    standby.volume = 1;
  }

  private drawCurrentFrame(): void {
    if (this.layout === null || this.timeline === null) {
      return;
    }
    const timeline = this.timeline;
    const active = this.activeVideo();
    const showEndCard = this.endCardVisible && timeline.endCard !== null;
    const activeCue = showEndCard ? null : activeCueAt(timeline, this.state.outputSeconds);
    drawTimelineFrame(this.ctx, {
      layout: this.layout,
      timeline,
      clip: showEndCard ? null : (timeline.clips.at(this.clipIndex) ?? null),
      video: active,
      videoReady: active.readyState >= 2,
      cue: activeCue?.cue ?? null,
      activeWordIndex: activeCue?.activeWordIndex ?? null,
      endCard: showEndCard ? { thumbnail: this.thumbnail } : null,
    });
  }

  private notify(force: boolean): void {
    const now = performance.now();
    if (!force && now - this.lastNotifyAt < NOTIFY_INTERVAL_MS) {
      return;
    }
    this.lastNotifyAt = now;
    const snapshot = this.getState();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}
