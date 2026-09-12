import { create } from "zustand";
import type { CaseFile, Trace } from "@/lib/engine/types";
import { loadRapSheet, saveCase } from "@/lib/engine/memory";

type Play = {
  trace: Trace;
  visible: number;
  playing: boolean;
};

type DuckState = {
  sheet: CaseFile[];
  play: Play | null;
  hydrate: () => void;
  archive: (file: CaseFile) => void;
  start: (trace: Trace) => void;
  reveal: () => void;
  finishPlay: () => void;
  stopPlay: () => void;
};

export const useDuck = create<DuckState>((set, get) => ({
  sheet: [],
  play: null,
  hydrate: () => set({ sheet: loadRapSheet() }),
  archive: (file) => set({ sheet: saveCase(file) }),
  start: (trace) => set({ play: { trace, visible: 1, playing: true } }),
  reveal: () => {
    const play = get().play;
    if (!play) return;
    const next = Math.min(play.visible + 1, play.trace.steps.length);
    set({ play: { ...play, visible: next, playing: next < play.trace.steps.length } });
  },
  finishPlay: () => {
    const play = get().play;
    if (!play) return;
    set({ play: { ...play, visible: play.trace.steps.length, playing: false } });
  },
  stopPlay: () => set({ play: null }),
}));
