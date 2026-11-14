# angel hours karaoke

Free home karaoke for your Mac, in a browser. Search any song on YouTube, queue it up, and play it full screen
on your TV while your mic plays through the speakers with reverb and echo. Videos that won't embed download
automatically. No API keys, no accounts, no ads. Styled like a 2003 personal homepage.

Originally made for Maren's 28th birthday, and inspired by [YToke](https://github.com/YuantongL/YToke)
(whose backend is down and whose video player no longer works).

- **Control panel** (your laptop screen): search YouTube, build a queue, pause, skip, seek, set the music volume.
- **TV window** (drag it onto the TV): plays the karaoke video full screen, with "up next" banners between songs.
- **Microphone**: your mic plays through the speakers with adjustable volume, reverb and echo.
- **Songs-sung counter**: a fake "u r visitor #000012" ticker that actually counts songs played.

Search uses [yt-dlp](https://github.com/yt-dlp/yt-dlp). Videos play through YouTube's embedded player.
Many karaoke channels (Sing King, KaraFun, karaoke SESH, …) block embedding, so for those the server downloads
the video (720p) into `cache/` in the background as soon as you queue it. The queue shows "downloading 40%"
and then "downloaded".

## What you need

- A Mac with Python 3 (it uses [uv](https://github.com/astral-sh/uv) if you have it, plain `venv` if not).
- Chrome, Edge or Arc.
- Optional: ffmpeg for better download quality (`brew install ffmpeg`).
- A TV or second screen, and a microphone.

It should run on Linux or Windows too with small changes to `run.sh`, but it's only been tested on macOS.

## Start it

```bash
./run.sh
```

The first run creates `.venv/` and installs yt-dlp. Your browser then opens the control panel at
http://localhost:8765. Stop it with Ctrl+C.

## Set up for a session

1. Connect the Mac to the TV with HDMI and use it as an **extended** display (not mirrored).
2. Click **open TV window**, drag that window onto the TV, then **click it once**. The click lets videos play
   with sound and switches the window to full screen. Press **F** or double-click to toggle full screen.
3. Plug in a microphone (wired USB or an audio interface is best). On the control panel, click **turn mic ON**,
   choose the mic under *input*, and set *mic volume*, *reverb* and *echo*.
4. Search, then use **+ queue** or **play NOW**. When a song ends, the next one starts automatically.

Keyboard shortcuts on the control panel: **Space** plays/pauses, **N** skips to the next song.

## Tips

- **Use Chrome** (or Edge or Arc). Safari works for playback, but it can't choose an audio output for the mic.
- **Latency matters.** Use wired speakers or the TV's HDMI audio, not Bluetooth or AirPlay, both for the mic and
  the video. If the TV has a *Game mode*, turn it on.
- The Mac's built-in mic plus its built-in speakers will feed back (howl). Use an external mic, or headphones.
- To use several mics, combine them into one *Aggregate Device* in macOS **Audio MIDI Setup**, then pick that
  device as the input.
- If a song says "unavailable", pick another version from the search results.

## Make it yours

The title says "Maren's Birthday Karaoke" unless you give it your own:

```bash
./run.sh --title "Jo's Karaoke Night"
```

That changes the title on the control panel, the TV window and the browser tabs. To keep a title without typing
it every time, set it once in your shell profile with `export KARAOKE_TITLE="Jo's Karaoke Night"`.

To swap the header picture, replace `static/img/finger-lilac.png` (it's shown about 3:1, wide and short).
Colors and fonts are at the top of `static/style.css`.

## The song counter

The "u r visitor #000000" ticker, the "songs sung" box and the "visitors" tag on the TV are all the same
counter. It goes up by one each time a song starts playing (pausing, restarting or reloading the page doesn't count
it again). It's saved in `data/counter.json`. To set it to a number, stop the server and write e.g.
`{"count": 0}` into that file. Delete the file to reset it to 0.

## Maintenance

- **Search or downloads stop working:** YouTube changes things often. Update yt-dlp:
  ```bash
  ./run.sh --update
  ```
- **Disk space:** downloaded songs are kept in `cache/` so they replay instantly, and are deleted after 60 days.
  You can delete the folder any time.
- **Better download quality:** this uses ffmpeg if it's installed (`brew install ffmpeg`). Without ffmpeg,
  downloads fall back to lower-quality single-file formats.

## Files

| File | What it does |
|---|---|
| `server.py` | Local web server: YouTube search, embed check, background downloads, video serving |
| `static/index.html`, `static/app.js` | Control panel: search, queue, transport controls |
| `static/mic.js` | Microphone passthrough with reverb, echo and a limiter (Web Audio) |
| `static/tv.html`, `static/tv.js` | TV window: YouTube embed or downloaded video, full screen |
| `static/style.css`, `static/img/` | The "angel hours" look, shared by both windows |
| `run.sh` | Sets up `.venv` on first run and starts the server |

The control panel and TV window talk to each other through a browser `BroadcastChannel`,
so both must be open in the same browser.
