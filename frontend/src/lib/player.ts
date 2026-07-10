import { useSyncExternalStore } from "react";

// Global music player: two <audio> elements streaming from the backend's
// /media/{id} endpoint — one playing, one preloading the predicted next track
// so transitions swap instantly. Codecs the WebView can't decode natively are
// retried with ?transcode=1 (FFmpeg → FLAC server-side), so every format plays.

export type PlayerTrack = {
    id: number;
    path: string;
    title: string;
    artist: string;
    album: string;
    duration: number; // seconds
    codec?: string;
    // Stable per-queue-entry identity (the same track can be queued twice) —
    // assigned internally when enqueued; used for drag-reorder animation.
    uid?: number;
};

let uidCounter = 1;
function withUids(tracks: PlayerTrack[]): PlayerTrack[] {
    return tracks.map((t) => ({ ...t, uid: uidCounter++ }));
}

export type RepeatMode = "off" | "all" | "one";

type PlayerState = {
    queue: PlayerTrack[];
    index: number; // -1 = nothing loaded
    playing: boolean;
    loading: boolean;
    position: number; // seconds
    duration: number; // seconds (from the element once known)
    volume: number; // 0..1
    shuffle: boolean;
    repeat: RepeatMode;
};

const VOLUME_KEY = "kazoo_player_volume";

let state: PlayerState = {
    queue: [],
    index: -1,
    playing: false,
    loading: false,
    position: 0,
    duration: 0,
    volume: (() => {
        const v = parseFloat(localStorage.getItem(VOLUME_KEY) || "1");
        return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 1;
    })(),
    shuffle: false,
    repeat: "off",
};

const listeners = new Set<() => void>();
function emit() {
    listeners.forEach((l) => l());
}
function set(patch: Partial<PlayerState>) {
    state = { ...state, ...patch };
    emit();
}

export function usePlayer(): PlayerState {
    return useSyncExternalStore(
        (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
        () => state,
        () => state,
    );
}

// --- audio elements -------------------------------------------------------
// Two elements: one plays, the other preloads the predicted next track so a
// transition is an instant swap instead of a fresh network load + buffer.

const players = [new Audio(), new Audio()];
let activeIdx = 0;
function act(): HTMLAudioElement { return players[activeIdx]; }
function standby(): HTMLAudioElement { return players[1 - activeIdx]; }

let triedTranscode = false;
// What the standby element currently holds: queue index + uid it was preloaded
// for (uid guards against queue mutations reusing an index), or null.
let preloaded: { index: number; uid: number; failed: boolean } | null = null;
// Shuffle's next pick is decided at preload time so the preload is what
// actually plays.
let shuffleNext: number | null = null;
const history: number[] = []; // indexes played, for prev under shuffle

for (const el of players) {
    el.preload = "auto";
    el.volume = state.volume;
}

function attachActiveListeners(el: HTMLAudioElement) {
    const ifActive = (fn: () => void) => () => { if (el === act()) fn(); };
    el.addEventListener("timeupdate", ifActive(() => {
        // Avoid re-render storms: only emit when the displayed second changes.
        const pos = el.currentTime;
        if (Math.floor(pos) !== Math.floor(state.position)) set({ position: pos });
        else state = { ...state, position: pos };
    }));
    el.addEventListener("durationchange", ifActive(() => {
        if (Number.isFinite(el.duration)) set({ duration: el.duration });
    }));
    el.addEventListener("play", ifActive(() => set({ playing: true })));
    el.addEventListener("pause", ifActive(() => set({ playing: false })));
    el.addEventListener("waiting", ifActive(() => set({ loading: true })));
    el.addEventListener("canplay", ifActive(() => set({ loading: false })));
    el.addEventListener("ended", ifActive(() => {
        if (state.repeat === "one") {
            el.currentTime = 0;
            void el.play();
            return;
        }
        next(true);
    }));
    el.addEventListener("error", () => {
        if (el !== act()) {
            // Preload failed (e.g. codec probe) — the swap path will fall
            // back to a normal load.
            if (preloaded) preloaded.failed = true;
            return;
        }
        // Native decode failed (e.g. ALAC in .m4a) — retry via server transcode.
        const t = current();
        if (t && !triedTranscode) {
            triedTranscode = true;
            set({ loading: true });
            el.src = `/media/${t.id}?transcode=1`;
            void el.play();
        } else {
            set({ playing: false, loading: false });
        }
    });
}
players.forEach(attachActiveListeners);

function current(): PlayerTrack | null {
    return state.index >= 0 && state.index < state.queue.length ? state.queue[state.index] : null;
}

// Codecs the WebView decodes natively; anything else streams via transcode.
const NATIVE_CODECS = new Set(["mp3", "flac", "wav", "ogg", "oga", "opus", "aac", "m4a", "webm", "mp4"]);

function mediaURL(t: PlayerTrack): string {
    return t.codec && !NATIVE_CODECS.has(t.codec.toLowerCase()) ? `/media/${t.id}?transcode=1` : `/media/${t.id}`;
}

// predictNext mirrors next()'s choice so the preload is what actually plays.
function predictNext(from: number): number | null {
    const n = state.queue.length;
    if (n === 0) return null;
    if (state.shuffle && n > 1) {
        if (shuffleNext === null || shuffleNext === from || shuffleNext >= n) {
            do { shuffleNext = Math.floor(Math.random() * n); } while (shuffleNext === from);
        }
        return shuffleNext;
    }
    const ni = from + 1;
    if (ni >= n) return state.repeat === "all" ? 0 : null;
    return ni;
}

// preloadNext points the standby element at the predicted next track. Also
// warms the transcode cache when that track needs FFmpeg.
function preloadNext(from: number) {
    const ni = predictNext(from);
    const t = ni !== null ? state.queue[ni] : null;
    if (ni === null || !t) {
        preloaded = null;
        standby().removeAttribute("src");
        return;
    }
    if (preloaded && !preloaded.failed && preloaded.index === ni && preloaded.uid === t.uid) return;
    preloaded = { index: ni, uid: t.uid ?? -1, failed: false };
    const el = standby();
    el.src = mediaURL(t);
    el.load();
}

function loadAndPlay(index: number) {
    const t = state.queue[index];
    if (!t) return;
    history.push(state.index);
    triedTranscode = false;
    shuffleNext = null;

    const pre = preloaded;
    preloaded = null;
    if (pre && !pre.failed && pre.index === index && pre.uid === (t.uid ?? -1)) {
        // The standby element already buffered this track — instant swap.
        const old = act();
        old.pause();
        old.removeAttribute("src");
        activeIdx = 1 - activeIdx;
        const el = act();
        if (el.currentTime > 0) el.currentTime = 0;
        set({ index, position: 0, duration: t.duration, loading: false });
        void el.play();
    } else {
        set({ index, position: 0, duration: t.duration, loading: true });
        act().src = mediaURL(t);
        void act().play();
    }
    updateMediaSession(t);
    preloadNext(index);
}

function updateMediaSession(t: PlayerTrack) {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
        title: t.title, artist: t.artist, album: t.album,
    });
}
if ("mediaSession" in navigator) {
    navigator.mediaSession.setActionHandler("play", () => toggle());
    navigator.mediaSession.setActionHandler("pause", () => toggle());
    navigator.mediaSession.setActionHandler("nexttrack", () => next());
    navigator.mediaSession.setActionHandler("previoustrack", () => prev());
}

// --- public API -----------------------------------------------------------------

// Replace the queue with these tracks and start at startIndex.
export function playQueue(tracks: PlayerTrack[], startIndex = 0) {
    if (!tracks.length) return;
    history.length = 0;
    state = { ...state, queue: withUids(tracks) };
    loadAndPlay(Math.max(0, Math.min(startIndex, tracks.length - 1)));
}

// Append; starts playing if nothing is queued.
export function addToQueue(tracks: PlayerTrack[]) {
    if (!tracks.length) return;
    const wasEmpty = state.queue.length === 0;
    state = { ...state, queue: [...state.queue, ...withUids(tracks)] };
    if (wasEmpty) loadAndPlay(0);
    else { emit(); preloadNext(state.index); }
}

// Reorder the queue (drag & drop); the now-playing pointer follows its track.
export function moveInQueue(from: number, to: number) {
    const n = state.queue.length;
    if (from === to || from < 0 || to < 0 || from >= n || to >= n) return;
    const q = [...state.queue];
    const [moved] = q.splice(from, 1);
    q.splice(to, 0, moved);
    let index = state.index;
    if (from === index) index = to;
    else if (from < index && to >= index) index--;
    else if (from > index && to <= index) index++;
    set({ queue: q, index });
    preloadNext(index);
}

export function toggle() {
    if (!current()) return;
    if (act().paused) void act().play();
    else act().pause();
}

export function next(fromEnded = false) {
    // predictNext is what the standby element preloaded — using it here is
    // what makes the transition an instant swap (incl. the shuffle pick).
    const ni = predictNext(state.index);
    if (ni === null) {
        if (fromEnded) set({ playing: false });
        return;
    }
    loadAndPlay(ni);
}

export function prev() {
    if (act().currentTime > 3) { act().currentTime = 0; return; }
    const last = history.pop();
    const back = last !== undefined && last >= 0 ? last : state.index - 1;
    if (back >= 0 && back < state.queue.length) {
        history.pop(); // loadAndPlay will re-push
        loadAndPlay(back);
    } else {
        act().currentTime = 0;
    }
}

export function jumpTo(index: number) {
    if (index >= 0 && index < state.queue.length) loadAndPlay(index);
}

export function removeFromQueue(index: number) {
    if (index < 0 || index >= state.queue.length) return;
    const q = state.queue.filter((_, i) => i !== index);
    if (index === state.index) {
        state = { ...state, queue: q };
        if (q.length === 0) { stop(); return; }
        loadAndPlay(Math.min(index, q.length - 1));
    } else {
        set({ queue: q, index: index < state.index ? state.index - 1 : state.index });
        preloadNext(state.index);
    }
}

export function clearQueue() {
    stop();
}

function stop() {
    for (const el of players) {
        el.pause();
        el.removeAttribute("src");
    }
    preloaded = null;
    shuffleNext = null;
    history.length = 0;
    set({ queue: [], index: -1, playing: false, loading: false, position: 0, duration: 0 });
}

export function seekTo(seconds: number) {
    if (!current()) return;
    act().currentTime = Math.max(0, Math.min(seconds, state.duration || act().duration || 0));
    set({ position: act().currentTime });
}

export function seekFrac(frac: number) {
    const d = state.duration || act().duration || 0;
    if (d > 0) seekTo(frac * d);
}

export function setVolume(v: number) {
    const vol = Math.max(0, Math.min(1, v));
    for (const el of players) el.volume = vol;
    localStorage.setItem(VOLUME_KEY, String(vol));
    set({ volume: vol });
}

export function toggleShuffle() {
    set({ shuffle: !state.shuffle });
    shuffleNext = null;
    preloadNext(state.index);
}

export function cycleRepeat() {
    set({ repeat: state.repeat === "off" ? "all" : state.repeat === "all" ? "one" : "off" });
    preloadNext(state.index);
}

// Convenience: map a backend LibraryTrack-shaped object to a PlayerTrack.
export function toPlayerTrack(t: { id: number; path: string; title: string; artist: string; album: string; duration: number; codec?: string }): PlayerTrack {
    return { id: t.id, path: t.path, title: t.title, artist: t.artist, album: t.album, duration: t.duration, codec: t.codec };
}
