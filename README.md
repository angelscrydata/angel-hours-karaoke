# Maren's Birthday Karaoke

A home karaoke setup for the Mac, inspired by [YToke](https://github.com/YuantongL/YToke)
(whose backend is down and whose video player no longer works).

- **Control panel** (your laptop screen): search YouTube, build a queue, pause, skip, seek, set the music volume.
- **TV window** (drag it onto the TV): plays the karaoke video full screen, with "Up next" banners.
- **Microphone**: your mic plays through the speakers with adjustable volume, reverb and echo.

No API keys or accounts are needed. Search uses [yt-dlp](https://github.com/yt-dlp/yt-dlp).
Videos play through YouTube's embedded player. Many karaoke channels (Sing King, KaraFun, karaoke SESH, …)
block embedding, so for those the server downloads the video (720p) into `cache/` in the background
as soon as you queue it. The queue shows "downloading 40%" and then "downloaded".

## Start it

```bash
./run.sh
```

The first run creates `.venv/` and installs yt-dlp. Your browser then opens the control panel at
http://localhost:8765. Stop it with Ctrl+C.

## Set up for a session

1. Connect the Mac to the TV with HDMI and use it as an **extended** display (not mirrored).
2. Click **Open TV window**, drag that window onto the TV, then **click it once**. The click lets videos play
   with sound and switches the window to full screen. Press **F** or double-click to toggle full screen.
3. Plug in a microphone (wired USB or an audio interface is best). On the control panel, click **Turn mic on**,
   choose the mic under *Input*, and set *Mic volume*, *Reverb* and *Echo*.
4. Search, then use **+ Queue** or **Play now**. When a song ends, the next one starts automatically.

Keyboard shortcuts on the control panel: **Space** plays/pauses, **N** skips to the next song.

## Tips

- **Use Chrome** (or Edge or Arc). Safari works for playback, but it can't choose an audio output for the mic.
- **Latency matters.** Use wired speakers or the TV's HDMI audio, not Bluetooth or AirPlay, both for the mic and
  the video. If the TV has a *Game mode*, turn it on.
- The Mac's built-in mic plus its built-in speakers will feed back (howl). Use an external mic, or headphones.
- To use several mics, combine them into one *Aggregate Device* in macOS **Audio MIDI Setup**, then pick that
  device as the input.
- If a song says "unavailable", pick another version from the search results.

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
| `run.sh` | Sets up `.venv` on first run and starts the server |

The control panel and TV window talk to each other through a browser `BroadcastChannel`,
so both must be open in the same browser.
