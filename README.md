# Kazoo Music Manager

Kazoo is a desktop app for managing a lossless music library. It indexes your
local files into a browsable library (artists, albums, playlists, the usual),
plays them, and can download whatever you're missing in FLAC from Tidal, Qobuz
or Amazon Music, tagged and filed to match the rest of your collection.

Built with Go, [Wails](https://wails.io) and React. Runs on Windows, macOS and
Linux, with a beta Android build.

## Features

**Library**

- SQLite-backed index over your folders, with realtime file watching. Files
  moved or retagged outside the app get picked up automatically.
- Player with queue, shuffle and repeat. The next track is preloaded so
  transitions don't stutter, and playback starts immediately.
- Codec, sample rate and bitrate shown on album cards and track rows.
- Artist pages with bio, photo, popular tracks and full discography, plus a
  "New releases" check that compares an artist's discography against what you
  have.
- Get Info on any track: file location, size, codec details, dates, play count
  and a dump of every tag in the file. Refresh Metadata re-reads tags from disk.
- Metadata editing for tracks, albums and artists.
- Deleting from the library also deletes the files, and cleans up album/artist
  folders that end up empty.

**Downloading**

- Search artists, albums, tracks and playlists, or paste a Spotify URL.
- Downloads come from the source shown on the quality badge. If you want a
  specific source, pin it with the dropdown.
- Artists whose music isn't on Spotify (or is only partially there) can be
  browsed and downloaded through the Qobuz catalog view.
- The queue survives restarts, skips files you already have, and when a source
  takes a scheduled break it waits and resumes on its own. Break clocks are
  tracked per source, so one slow source doesn't hold up the rest.
- Synced lyrics (`.lrc`) can be saved next to each download. Cover art, M3U8
  export and failure reports are there too.

**Playlist sync**

- Sync a Spotify playlist and see which of its tracks you already have.
- Download just the missing ones; they file into your normal folder structure.
- Fix match lets you pin a playlist entry to the exact local file it should
  count as, when the automatic matching gets it wrong.

**Tools**

Audio quality analyzer, converter, resampler, file organizer and lyrics
manager. FFmpeg is downloaded automatically the first time something needs it.

## Screenshots

| Library | Artist page |
|---|---|
| ![Library](docs/screenshots/library.png) | ![Artist](docs/screenshots/artist.png) |

![Artist releases](docs/screenshots/artist-releases.png)

| Search & download | Playlist sync |
|---|---|
| ![Search](docs/screenshots/search.png) | ![Playlist sync](docs/screenshots/playlist-sync.png) |

| Download queue | Settings |
|---|---|
| ![Queue](docs/screenshots/queue.png) | ![Settings](docs/screenshots/settings.png) |

## Installation

Grab the latest build from [Releases](../../releases):

| Platform | File |
|---|---|
| Windows | `Kazoo.exe` (portable) |
| macOS | `Kazoo.dmg` |
| Linux x64 | `Kazoo.AppImage` |
| Linux ARM64 | `Kazoo-ARM.AppImage` |
| Android (beta) | `Kazoo.apk` (arm64, sideload) |

Desktop builds check for updates at launch and can update themselves in place.
There's also a "Check now" button in Settings.

On first launch, add your music folder under Library. Kazoo scans it and keeps
watching for changes. Your first library folder is also where downloads go, so
new music becomes part of the library as soon as it finishes.

App data (library DB, playlists, artist art, config) lives in `~/.spindle`.
That's a holdover from the app's previous name, kept so updating never orphans
an existing library.

Linux needs `webkit2gtk-4.1` (`sudo apt install libwebkit2gtk-4.1-0` on
Ubuntu/Debian).

## Building from source

You'll need Go 1.26+, Node 24+, pnpm and the
[Wails CLI](https://wails.io/docs/gettingstarted/installation).

```bash
git clone https://github.com/loliver1823/kazoo.git
cd kazoo
cd frontend && pnpm install && cd ..
wails dev      # live-reload development build
wails build    # production binary in build/bin
```

### Server mode

The same binary can run headless, serving the full app over HTTP to any
browser on the machine:

```bash
kazoo serve 127.0.0.1:8899
```

### Android

The backend is pure Go, so it cross-compiles to a native Android binary that a
small WebView shell runs on-device:

```powershell
wails build                       # produces frontend/dist
.\scripts\build-android.ps1       # cross-compiles the server + assembles the APK
# -> android-app/app/build/outputs/apk/debug/app-debug.apk (arm64)
```

Requires JDK 17+, the Android SDK and Gradle 8.5+. Downloads go to the app's
scoped storage (`Android/data/wtf.kazoo/files/Music`).

## File layout

File and folder names come from configurable templates. The default:

```
Library/
└── Bleachers/
    └── [2026] everyone for ten minutes/
        ├── 01 - sideways.flac
        ├── 01 - sideways.lrc
        └── ...
```

Templates, existing-file detection, source order, cover art quality and lyric
behaviour are all in Settings.

## Disclaimer

Kazoo is a library management tool. It isn't affiliated with or endorsed by
Spotify, Tidal, Qobuz, Amazon Music or any other service. Downloading
copyrighted material may be illegal where you live. Use it for content you
have the right to access, and support the artists you love.

## License

[MIT](LICENSE)
