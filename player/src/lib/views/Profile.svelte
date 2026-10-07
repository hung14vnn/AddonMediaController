<script lang="ts">
  import {
    getLastfmStatus,
    getScanStatus,
    getServerInfo,
    getSession,
    setLastfmScrobbling,
    SubsonicError,
    startScan,
    type LastfmStatus,
    type ScanStatus,
    type ServerInfo,
  } from "../api";
  import { build, buildLabel } from "../build";
  import Avatar from "../components/Avatar.svelte";
  import Icon from "../components/Icon.svelte";
  import Slider from "../components/Slider.svelte";
  import { plural } from "../format";
  import { ui } from "../ui.svelte";
  import {
    audioSettings,
    type AudioEngine,
  } from "../playback/audioSettings.svelte";
  import { enhancerMode } from "../playback/cutoffDetector";
  import { getPlayer } from "../player.svelte";

  let { onsignout }: { onsignout: () => void } = $props();

  const session = getSession();
  const host = (() => {
    try {
      return new URL(session?.base ?? "", location.href).host;
    } catch {
      return session?.base ?? "";
    }
  })();

  let server = $state<ServerInfo | null>(null);
  let scan = $state<ScanStatus | null>(null);
  let scanError = $state("");
  let starting = $state(false);
  let pollTimer: ReturnType<typeof setTimeout> | undefined;

  getServerInfo()
    .then((s) => (server = s))
    .catch(() => {});
  if (!ui.me) ui.loadMe();

  async function refreshScan(wasScanning = false) {
    try {
      scan = await getScanStatus();
      scanError = "";
    } catch (e) {
      scanError = e instanceof Error ? e.message : "Couldn’t read scan status";
      return;
    }
    clearTimeout(pollTimer);
    if (scan.scanning) pollTimer = setTimeout(() => refreshScan(true), 2000);
    else if (wasScanning) ui.showToast("Library scan finished");
  }

  async function rescan() {
    starting = true;
    scanError = "";
    try {
      scan = await startScan();
      ui.showToast("Library scan started");
      refreshScan(true);
    } catch (e) {
      scanError =
        e instanceof SubsonicError && e.code === 50
          ? "Only administrators can start a library scan."
          : e instanceof Error
            ? e.message
            : "Couldn’t start the scan";
    } finally {
      starting = false;
    }
  }

  refreshScan();
  $effect(() => () => clearTimeout(pollTimer));

  const player = getPlayer();
  /** How the Sound Enhancer treats the playing track, or null before one loads. */
  const enhancing = $derived(
    player.enhancerSource ? enhancerMode(player.enhancerSource) : null,
  );
  const engines: [AudioEngine, string][] = [
    ["element", "Standard"],
    ["webaudio", "Web Audio (Beta)"],
  ];

  // Last.fm is linked in the web app (Settings › Connections); here it is shown,
  // and scrobbling can be switched on or off.
  let lastfm = $state<LastfmStatus | null>(null);
  let lastfmError = $state("");
  let lastfmBusy = $state(false);

  getLastfmStatus()
    .then((s) => (lastfm = s))
    .catch(() => (lastfmError = "Couldn’t check Last.fm"));

  async function toggleScrobbling() {
    if (!lastfm) return;
    lastfmBusy = true;
    try {
      lastfm = await setLastfmScrobbling(!lastfm.scrobbling);
    } catch {
      ui.showToast("Couldn’t change scrobbling");
    } finally {
      lastfmBusy = false;
    }
  }

  let cacheCleared = $state(false);
  async function clearArtCache() {
    try {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k.startsWith("art-")).map((k) => caches.delete(k)),
      );
      cacheCleared = true;
      ui.showToast("Artwork cache cleared");
    } catch {
      ui.showToast("Couldn’t clear the cache");
    }
  }

  import { deleteAllOfflineTracks, listOfflineTrackMetadata } from "../offline";
  let offlineCount = $state<number | null>(null);
  let clearingDownloads = $state(false);

  $effect(() => {
    if (session?.username) {
      listOfflineTrackMetadata(session.username)
        .then((tracks) => (offlineCount = tracks.length))
        .catch(() => (offlineCount = 0));
    }
  });

  async function clearDownloads() {
    if (!session?.username) return;
    if (!confirm("Remove all downloaded songs from this device?")) return;
    clearingDownloads = true;
    try {
      await deleteAllOfflineTracks(session.username);
      offlineCount = 0;
      ui.showToast("Removed downloaded songs");
    } catch {
      ui.showToast("Couldn’t remove downloaded songs");
    } finally {
      clearingDownloads = false;
    }
  }

  import {
    clearPlaybackLog,
    readPlaybackLog,
    isPlaybackLogEnabled,
    setPlaybackLogEnabled,
    readApiErrorLog,
    clearApiErrorLog,
  } from "../playback/debugLog";
  let playbackLog = $state(readPlaybackLog());
  let logEnabled = $state(isPlaybackLogEnabled());
  let apiErrorLog = $state(readApiErrorLog());
  function togglePlaybackLog() {
    logEnabled = !logEnabled;
    setPlaybackLogEnabled(logEnabled);
    if (!logEnabled) {
      resetPlaybackLog();
    }
  }

  function parseLog(lines: string[]) {
    let currentTrack = "";
    return lines.slice(-150).map((line) => {
      const parts = line.split(" ");
      const timePart = parts[0] || "";
      let time = timePart.split(".")[0] || "";

      if (time) {
        const [h, m, s] = time.split(":").map(Number);
        if (!isNaN(h) && !isNaN(m) && !isNaN(s)) {
          const d = new Date();
          d.setUTCHours(h, m, s, 0);
          const localH = d.getHours().toString().padStart(2, "0");
          const localM = d.getMinutes().toString().padStart(2, "0");
          const localS = d.getSeconds().toString().padStart(2, "0");
          time = `${localH}:${localM}:${localS}`;
        }
      }

      const event = parts[1] || "";
      let hidden = false;
      let detailStart = 2;
      if (parts[2] === "[hidden]") {
        hidden = true;
        detailStart = 3;
      }
      const detail = parts.slice(detailStart).join(" ");

      let track = currentTrack;
      if (event === "load") {
        const match = detail.match(/"(.*?)"/);
        if (match) {
          currentTrack = match[1];
          track = currentTrack;
        }
      } else if (event === "prefetch" || event === "prefetch-failed") {
        const match = detail.match(/"(.*?)"/);
        if (match) {
          track = match[1];
        }
      }

      return {
        raw: line,
        time,
        event,
        hidden,
        detail,
        currentTrack: track,
      };
    });
  }

  function parseApiErrorLog(lines: string[]) {
    return lines.slice(-150).map((line) => {
      const timePart = line.split(" ")[0] || "";
      let time = timePart.split(".")[0] || "";

      if (time) {
        const [h, m, s] = time.split(":").map(Number);
        if (!isNaN(h) && !isNaN(m) && !isNaN(s)) {
          const d = new Date();
          d.setUTCHours(h, m, s, 0);
          const localH = d.getHours().toString().padStart(2, "0");
          const localM = d.getMinutes().toString().padStart(2, "0");
          const localS = d.getSeconds().toString().padStart(2, "0");
          time = `${localH}:${localM}:${localS}`;
        }
      }

      const content = line.substring(timePart.length + 1);
      return {
        raw: line,
        time,
        content,
      };
    });
  }

  function getEventIcon(event: string) {
    const ev = event.toLowerCase();
    if (ev.includes("play")) return "play";
    if (ev.includes("pause")) return "pause";
    if (ev.includes("error") || ev.includes("abort") || ev.includes("fail"))
      return "close";
    if (ev === "ended" || ev === "next") return "next";
    if (ev === "waiting" || ev === "stalled" || ev.includes("load"))
      return "clock";
    if (ev.includes("visibility") || ev.includes("pagehide")) return "browse";
    return "note";
  }

  function formatEventFriendly(
    event: string,
    detail: string,
    currentTrack: string,
  ) {
    let name = event;
    let info = detail;

    switch (event) {
      case "load":
        name = "Loading Track";
        break;
      case "play":
        name = "Play Requested";
        break;
      case "playing":
        name = "Playing";
        break;
      case "pause":
        name = "Paused (System/Browser)";
        break;
      case "pause-request":
        name = "Paused (User Action)";
        break;
      case "waiting":
        name = "Buffering...";
        break;
      case "canplay":
        name = "Ready to Play";
        break;
      case "emptied":
        name = "Buffer Emptied / Track Changed";
        break;
      case "visibility":
        name = "App Visibility";
        info =
          detail === "hidden"
            ? "Hidden (Background)"
            : detail === "visible"
              ? "Visible (Foreground)"
              : detail;
        break;
      case "play-rejected":
        name = "Play Blocked (Auto-play policy)";
        break;
      case "prefetch":
        name = "Prefetching Next Track";
        break;
      case "prefetch-failed":
        name = "Prefetch Failed";
        break;
      case "media-error":
        name = "Audio Error";
        break;
      case "stall-reload":
        name = "Network Stalled, Reloading";
        break;
      case "pagehide":
        name = "App Closed/Hidden";
        break;
      case "app-start":
        name = "App Started";
        break;
      case "standby-ready":
        name = "Next Track Ready (Standby)";
        break;
      case "handoff-early":
        name = "Handing Over to Next Track";
        break;
      case "capped-end":
        name = "Track Ended at Real Length";
        break;
      case "system-pause":
        name = "Paused by System, Will Resume";
        break;
      case "blob-cancel":
        name = "Next-Track Download Cancelled";
        break;
      case "stall-timeout":
        name = "Stream Stalled, Retrying";
        break;
      case "sleep-timer-stop":
        name = "Sleep Timer: Playback Stopped";
        break;
      case "ended":
        name = "Track Ended";
        break;
      case "suspend":
        name = "Network Suspended";
        break;
      case "abort":
        name = "Playback Aborted";
        break;
      case "timeupdate":
        name = "Time Update";
        break;
    }

    if (info.includes("rs=") && info.includes("ns=")) {
      info = `[State: ${info}]`;
    }

    return { name, info, track: currentTrack };
  }

  const parsedLog = $derived(parseLog(playbackLog));
  const parsedApiErrorLog = $derived(parseApiErrorLog(apiErrorLog));

  import { tick } from "svelte";

  function refreshPlaybackLog() {
    playbackLog = readPlaybackLog();
    tick().then(() => {
      if (logEntriesContainer)
        logEntriesContainer.scrollTop = logEntriesContainer.scrollHeight;
    });
  }

  function refreshApiErrorLog() {
    apiErrorLog = readApiErrorLog();
    tick().then(() => {
      if (apiErrorLogEntriesContainer)
        apiErrorLogEntriesContainer.scrollTop =
          apiErrorLogEntriesContainer.scrollHeight;
    });
  }

  async function copyPlaybackLog() {
    playbackLog = readPlaybackLog();
    try {
      await navigator.clipboard.writeText(
        [`# copied from build ${buildLabel}`, ...playbackLog].join("\n"),
      );
      ui.showToast("Playback log copied");
    } catch {
      ui.showToast("Couldn’t copy — select the log below instead");
    }
  }

  function resetPlaybackLog() {
    clearPlaybackLog();
    playbackLog = [];
  }

  function resetApiErrorLog() {
    clearApiErrorLog();
    apiErrorLog = [];
  }

  async function copyApiErrorLog() {
    apiErrorLog = readApiErrorLog();
    try {
      await navigator.clipboard.writeText(apiErrorLog.join("\n"));
      ui.showToast("API error log copied");
    } catch {
      ui.showToast("Couldn’t copy — select the log below instead");
    }
  }

  function signOut() {
    if (confirm("Sign out of hify? Your queue on this device will be cleared."))
      onsignout();
  }

  const displayName = $derived(
    ui.me?.username ?? session?.username ?? "Account",
  );
  const isAdmin = $derived(!!ui.me?.adminRole);
  /** Home-screen app vs browser tab: background playback differs between them. */
  const installed =
    matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;

  let logEntriesContainer = $state<HTMLDivElement>();
  let apiErrorLogEntriesContainer = $state<HTMLDivElement>();
</script>

<div class="page">
  <h1 class="page-title">Account</h1>

  <section class="hero pad">
    <Avatar username={ui.me?.username ?? session?.username} size={84} />
    <div class="who">
      <h2>{displayName}</h2>
      <div class="badges">
        {#if isAdmin}<span class="badge accent">Administrator</span>{/if}
        <span class="badge">{session?.apiKey ? "API key" : "App password"}</span
        >
      </div>
      <span class="muted host">{host}</span>
    </div>
  </section>

  <h3 class="group-title">Playback</h3>
  <div class="group">
    <div class="row engine">
      <span class="icon-box" style="background: var(--accent);"
        ><Icon name="speaker" size={18} /></span
      >
      <div class="text">
        <span class="label">Audio Engine</span>
        <span class="detail">
          {#if audioSettings.engine === "webaudio"}
            Uses Web Audio API — a more flexible and feature-rich option but can
            be unstable in some devices.
          {:else}
            Plays straight from the audio element — the most reliable in the
            background on mobile devices.
          {/if}
        </span>
      </div>
      <div class="segmented" role="radiogroup" aria-label="Audio engine">
        {#each engines as [value, name] (value)}
          <button
            role="radio"
            aria-checked={audioSettings.engine === value}
            class:on={audioSettings.engine === value}
            onclick={() => audioSettings.setEngine(value)}>{name}</button
          >
        {/each}
      </div>
    </div>
    {#if audioSettings.restartNeeded}
      <div class="row" style="border-top: 0.5px solid var(--hairline);">
        <div class="text">
          <span class="detail"
            >Restart hify to switch the audio engine</span
          >
        </div>
        <button class="btn small accent" onclick={() => location.reload()}
          >Restart</button
        >
      </div>
    {/if}
    <a
      class="row link"
      href="#/equalizer"
      style="border-top: 0.5px solid var(--hairline);"
    >
      <span class="icon-box" style="background: var(--accent);"
        ><Icon name="sliders" size={18} /></span
      >
      <div class="text">
        <span class="label">Equalizer</span>
        <span class="detail">
          {#if !player.webAudio}
            Requires the Web Audio engine
          {:else if audioSettings.eqEnabled}
            {audioSettings.preset}
          {:else}
            Off
          {/if}
        </span>
      </div>
      <Icon name="chevronRight" size={16} class="chev" />
    </a>
    <label
      class="row switch-row"
      class:disabled={!player.webAudio}
      style="border-top: 0.5px solid var(--hairline);"
    >
      <span class="icon-box" style="background: var(--accent);"
        ><Icon name="wand" size={18} /></span
      >
      <div class="text">
        <span class="label">Sound Enhancer</span>
        <span class="detail">
          {#if !player.webAudio}
            Requires the Web Audio engine
          {:else if audioSettings.enhancer && enhancing && enhancing !== "unknown"}
            {#if enhancing === "lossless"}
              This song is lossless — nothing to restore.
            {:else if enhancing === "detail"}
              Compressed, full bandwidth — adding fine high detail.
            {:else}
              Restoring treble above {(
                (player.enhancerSource?.cutoff ?? 0) / 1000
              ).toFixed(1)} kHz.
            {/if}
          {:else}
            Adds brightness and space to compressed music.
          {/if}
        </span>
      </div>
      <input
        type="checkbox"
        class="switch"
        checked={audioSettings.enhancer}
        disabled={!player.webAudio}
        onchange={(e) => audioSettings.setEnhancer(e.currentTarget.checked)}
      />
    </label>
    {#if player.webAudio && audioSettings.enhancer}
      <div class="row level" style="border-top: 0.5px solid var(--hairline);">
        <span class="detail">Low</span>
        <div class="level-slider">
          <Slider
            value={audioSettings.enhancerLevel}
            max={1}
            step={0.05}
            label="Sound Enhancer level"
            onchange={(v) => audioSettings.setEnhancerLevel(v)}
            oninput={(v) => v !== null && audioSettings.setEnhancerLevel(v)}
          />
        </div>
        <span class="detail">High</span>
      </div>
    {/if}
    <label
      class="row switch-row"
      class:disabled={!player.webAudio}
      style="border-top: 0.5px solid var(--hairline);"
    >
      <span class="icon-box" style="background: var(--accent);"
        ><Icon name="speaker" size={18} /></span
      >
      <div class="text">
        <span class="label">ReplayGain</span>
        <span class="detail">
          {#if !player.webAudio}
            Requires the Web Audio engine
          {:else if audioSettings.soundCheck}
            Adjusts volume between songs to match their perceived loudness.
          {:else}
            Off — songs play at their original volume.
          {/if}
        </span>
      </div>
      <input
        type="checkbox"
        class="switch"
        checked={audioSettings.soundCheck}
        disabled={!player.webAudio}
        onchange={(e) => audioSettings.setSoundCheck(e.currentTarget.checked)}
      />
    </label>
  </div>
  <h3 class="group-title">Storage</h3>
  <div class="group">
    <div class="row">
      <span class="icon-box" style="background: var(--accent);"
        ><Icon name="album" size={18} /></span
      >
      <div class="text">
        <span class="label">Artwork Cache</span>
        <span class="detail"
          >Cover art saved for offline use on this device.</span
        >
      </div>
      <button
        class="btn small secondary"
        disabled={cacheCleared}
        onclick={clearArtCache}>{cacheCleared ? "Cleared" : "Clear"}</button
      >
    </div>
    <div class="row" style="border-top: 0.5px solid var(--hairline);">
      <span class="icon-box" style="background: var(--accent);"
        ><Icon name="download" size={18} /></span
      >
      <div class="text">
        <span class="label">Downloaded Songs</span>
        <span class="detail"
          >{offlineCount !== null
            ? offlineCount === 0
              ? "No songs"
              : plural(offlineCount, "song")
            : "Checking…"}</span
        >
      </div>
      <button
        class="btn small secondary"
        disabled={offlineCount === null ||
          offlineCount === 0 ||
          clearingDownloads}
        onclick={clearDownloads}
      >
        {clearingDownloads ? "Clearing…" : "Clear"}
      </button>
    </div>
  </div>

  <h3 class="group-title">Last.fm</h3>
  <div class="group">
    {#if !lastfm}
      <div class="row">
        <span class="icon-box lastfm">fm</span>
        <div class="text">
          <span class="label">Last.fm</span>
          <span class="detail">
            {#if lastfmError}<span class="err">{lastfmError}</span
              >{:else}Checking…{/if}
          </span>
        </div>
      </div>
    {:else if lastfm.linked}
      <div class="row">
        <span class="icon-box lastfm">fm</span>
        <div class="text">
          <span class="label">Connected as {lastfm.username}</span>
          <span class="detail"
            >Recommendations on Home are based on your Last.fm listening.</span
          >
        </div>
      </div>
      <div class="row" style="border-top: 0.5px solid var(--hairline);">
        <span class="icon-box" style="background: var(--accent);"
          ><Icon name="radio" size={18} /></span
        >
        <div class="text">
          <span class="label">Scrobble Plays</span>
          <span class="detail">
            {lastfm.scrobbling
              ? "Songs you play here are added to Last.fm."
              : "Off — plays here aren’t added to Last.fm."}
          </span>
        </div>
        <button
          class="btn small"
          class:secondary={lastfm.scrobbling}
          class:accent={!lastfm.scrobbling}
          disabled={lastfmBusy}
          onclick={toggleScrobbling}
        >
          {lastfm.scrobbling ? "Turn Off" : "Turn On"}
        </button>
      </div>
    {:else}
      <div class="warning" role="alert">
        <span class="warning-mark" aria-hidden="true">!</span>
        <div class="text">
          <span class="label">Last.fm isn’t connected</span>
          <span class="detail">
            {#if lastfm.available}
              Connect it in the web app (Settings › Connections) to get personal
              recommendations on Home and scrobble what you play.
            {:else}
              Last.fm hasn’t been set up on this server yet. Ask your
              administrator to add a Last.fm API key.
            {/if}
          </span>
        </div>
      </div>
    {/if}
  </div>

  <h3 class="group-title">Library</h3>
  <div class="group">
    <div class="row">
      <span class="icon-box scan" class:spinning={scan?.scanning}
        ><Icon name="refresh" size={18} /></span
      >
      <div class="text">
        <span class="label">Library Scan</span>
        <span class="detail">
          {#if scanError}
            <span class="err">{scanError}</span>
          {:else if !scan}
            Checking…
          {:else if scan.scanning}
            Scanning{#if scan.count}&nbsp;· {plural(scan.count, "item").replace(
                String(scan.count),
                scan.count.toLocaleString(),
              )}{/if}…
          {:else}
            Up to date{#if scan.count}&nbsp;· {plural(
                scan.count,
                "item",
              ).replace(String(scan.count), scan.count.toLocaleString())}{/if}
          {/if}
        </span>
      </div>
      <button
        class="btn small"
        disabled={starting || !!scan?.scanning}
        onclick={rescan}
      >
        {scan?.scanning ? "Scanning…" : starting ? "Starting…" : "Rescan"}
      </button>
    </div>
    {#if scan?.scanning}
      <div class="progress" aria-hidden="true"><span></span></div>
    {/if}
  </div>

  <h3 class="group-title">Server</h3>
  <div class="group">
    <div class="row">
      <span class="icon-box"><Icon name="server" size={18} /></span>
      <div class="text">
        <span class="label">{server?.type ?? "Subsonic server"}</span>
        <span class="detail">{host}</span>
      </div>
    </div>
    <dl>
      {#if server?.serverVersion}<div>
          <dt>Server version</dt>
          <dd>{server.serverVersion}</dd>
        </div>{/if}
      {#if server?.version}<div>
          <dt>API version</dt>
          <dd>
            {server.version}{#if server.openSubsonic}&nbsp;· OpenSubsonic{/if}
          </dd>
        </div>{/if}
      {#if ui.me?.maxBitRate}<div>
          <dt>Max bitrate</dt>
          <dd>{ui.me.maxBitRate} kbps</dd>
        </div>{/if}
      <div>
        <dt>Scrobbling</dt>
        <dd>{ui.me?.scrobblingEnabled === false ? "Off" : "On"}</dd>
      </div>
    </dl>
  </div>

  <h3 class="group-title">App</h3>
  <div class="group">
    <div class="row">
      <span class="icon-box" style="background: var(--accent);"
        ><Icon name="note" size={18} /></span
      >
      <div class="text">
        <span class="label">hify</span>
        <span class="detail"
          >{installed ? "Installed app" : "Running in the browser"}</span
        >
      </div>
    </div>
    <dl>
      <div>
        <dt>Version</dt>
        <dd>{buildLabel}</dd>
      </div>
      <div>
        <dt>Built</dt>
        <dd>{new Date(build.time).toLocaleString()}</dd>
      </div>
    </dl>
  </div>

  <h3 class="group-title">Diagnostics</h3>
  <div class="group">
    <div class="row">
      <span class="icon-box"><Icon name="server" size={18} /></span>
      <div class="text">
        <span class="label">Playback Log</span>
        <span class="detail">
          {logEnabled ? "Recording" : "Paused"} ·
          {playbackLog.length ? plural(playbackLog.length, "event") : "Empty"}
        </span>
      </div>
      <button
        class="btn small"
        class:secondary={logEnabled}
        class:accent={!logEnabled}
        onclick={togglePlaybackLog}
      >
        {logEnabled ? "Disable" : "Enable"}
      </button>
    </div>
    {#if playbackLog.length}
      <details
        class="log"
        ontoggle={(e) => {
          if (e.currentTarget.open) {
            tick().then(() => {
              if (logEntriesContainer)
                logEntriesContainer.scrollTop =
                  logEntriesContainer.scrollHeight;
            });
          }
        }}
      >
        <summary>View log details</summary>
        <div class="log-actions">
          <button class="btn small secondary" onclick={copyPlaybackLog}
            >Copy to Clipboard</button
          >
          <button class="btn small secondary danger" onclick={resetPlaybackLog}
            >Clear Log</button
          >
          <button
            class="btn small secondary"
            style="padding: 0 8px; margin-left: auto;"
            title="Refresh log"
            aria-label="Refresh"
            onclick={refreshPlaybackLog}
          >
            <Icon name="refresh" size={16} />
          </button>
        </div>
        <div class="log-entries" bind:this={logEntriesContainer}>
          {#each parsedLog as entry}
            {@const friendly = formatEventFriendly(
              entry.event,
              entry.detail,
              entry.currentTrack,
            )}
            <div class="log-entry">
              <div class="time">{entry.time}</div>
              <Icon
                name={getEventIcon(entry.event)}
                size={14}
                class="event-icon"
              />
              <div class="event-details">
                <span class="event-name">{friendly.name}</span>
                {#if entry.hidden}<span class="badge small">Hidden</span>{/if}
                {#if friendly.track && entry.event !== "load"}<span
                    class="event-track">· {friendly.track}</span
                  >{/if}
                {#if friendly.info}<span class="event-detail"
                    >{friendly.info}</span
                  >{/if}
              </div>
            </div>
          {/each}
        </div>
      </details>
    {/if}
  </div>

  <h3 class="group-title">Error Reports</h3>
  <div class="group">
    <div class="row">
      <span class="icon-box" style="background: #e74c3c;"
        ><Icon name="server" size={18} /></span
      >
      <div class="text">
        <span class="label">API Error Log</span>
        <span class="detail">
          {apiErrorLog.length
            ? plural(apiErrorLog.length, "error")
            : "No errors"}
        </span>
      </div>
    </div>
    {#if apiErrorLog.length}
      <details
        class="log"
        ontoggle={(e) => {
          if (e.currentTarget.open) {
            tick().then(() => {
              if (apiErrorLogEntriesContainer)
                apiErrorLogEntriesContainer.scrollTop =
                  apiErrorLogEntriesContainer.scrollHeight;
            });
          }
        }}
      >
        <summary>View API errors</summary>
        <div class="log-actions">
          <button class="btn small secondary" onclick={copyApiErrorLog}
            >Copy to Clipboard</button
          >
          <button class="btn small secondary danger" onclick={resetApiErrorLog}
            >Clear Log</button
          >
          <button
            class="btn small secondary"
            style="padding: 0 8px; margin-left: auto;"
            title="Refresh log"
            aria-label="Refresh"
            onclick={refreshApiErrorLog}
          >
            <Icon name="refresh" size={16} />
          </button>
        </div>
        <div class="log-entries" bind:this={apiErrorLogEntriesContainer}>
          {#each parsedApiErrorLog as entry}
            <div class="log-entry">
              <div class="time">{entry.time}</div>
              <Icon name="close" size={14} class="event-icon" />
              <div class="event-details">
                <span class="event-name">{entry.content}</span>
              </div>
            </div>
          {/each}
        </div>
      </details>
    {/if}
  </div>

  <div class="pad signout">
    <button class="signout-btn" onclick={signOut}
      ><Icon name="signOut" size={18} />Sign Out</button
    >
  </div>
</div>

<style>
  .hero {
    display: flex;
    align-items: center;
    gap: 20px;
    margin-bottom: 28px;
    animation: text-in 0.5s cubic-bezier(0.2, 0.8, 0.2, 1) both;
  }
  .who {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }
  h2 {
    margin: 0;
    font-size: 26px;
    font-weight: 700;
    letter-spacing: -0.02em;
  }
  .badges {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .badge {
    font-size: 11px;
    font-weight: 600;
    padding: 3px 8px;
    border-radius: 999px;
    color: var(--text-2);
    background: var(--fill);
  }
  .badge.accent {
    color: var(--accent);
    background: var(--accent-soft);
  }
  .host {
    font-size: 13px;
  }
  .group-title {
    margin: 0 var(--gutter) 8px;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-2);
  }
  .group {
    margin: 0 var(--gutter) 26px;
    max-width: 720px;
    border-radius: 12px;
    background: var(--fill);
    overflow: hidden;
    animation: text-in 0.5s cubic-bezier(0.2, 0.8, 0.2, 1) 0.08s both;
  }
  .log {
    border-top: 0.5px solid var(--hairline);
    padding: 10px 14px;
  }
  .log summary {
    cursor: pointer;
    color: var(--accent);
    font-size: 13px;
    font-weight: 500;
    outline: none;
  }
  .log-actions {
    display: flex;
    gap: 8px;
    margin-top: 12px;
  }
  .log-actions .btn.danger {
    color: #ff3b30;
  }
  .log-entries {
    margin: 12px 0 0;
    padding: 4px 0;
    background: var(--bg2);
    border-radius: 8px;
    max-height: 400px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
  }
  .log-entry {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 6px 12px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
      monospace;
    font-size: 12px;
    line-height: 1.4;
    border-bottom: 1px solid var(--hairline);
  }
  .log-entry:last-child {
    border-bottom: none;
  }
  .log-entry .time {
    color: var(--text-muted);
    flex-shrink: 0;
    font-size: 11px;
    margin-top: 1px;
  }
  .log-entry :global(.event-icon) {
    color: var(--text-2);
    margin-top: 2px;
    flex-shrink: 0;
  }
  .event-details {
    display: flex;
    flex-wrap: wrap;
    column-gap: 6px;
    row-gap: 2px;
    align-items: center;
    min-width: 0;
  }
  .event-name {
    font-weight: 600;
    color: var(--text);
  }
  .event-track {
    color: var(--text-2);
    font-style: italic;
  }
  .event-detail {
    color: var(--text-2);
    word-break: break-word;
  }
  .badge.small {
    font-size: 9px;
    padding: 1px 4px;
    border-radius: 4px;
    text-transform: uppercase;
    font-weight: 700;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 14px;
  }
  .icon-box {
    width: 32px;
    height: 32px;
    border-radius: 8px;
    display: grid;
    place-items: center;
    color: #fff;
    background: #8e8e93;
    flex-shrink: 0;
  }
  .icon-box.scan {
    background: var(--accent);
  }
  .row.link {
    color: var(--text);
  }
  .row.link :global(.chev) {
    color: var(--text-3);
    flex-shrink: 0;
  }
  .switch-row {
    cursor: pointer;
  }
  .switch-row.disabled {
    opacity: 0.5;
    cursor: default;
  }
  /* iOS switch */
  .switch {
    appearance: none;
    position: relative;
    width: 51px;
    height: 31px;
    margin: 0;
    flex-shrink: 0;
    border-radius: 999px;
    background: var(--fill-strong);
    transition: background-color 0.2s ease;
    cursor: inherit;
  }
  .switch::after {
    content: "";
    position: absolute;
    top: 2px;
    left: 2px;
    width: 27px;
    height: 27px;
    border-radius: 50%;
    background: #fff;
    box-shadow: 0 2px 6px rgb(0 0 0 / 0.25);
    transition: transform 0.2s cubic-bezier(0.3, 0.7, 0.4, 1);
  }
  .switch:checked {
    background: #34c759;
  }
  .switch:checked::after {
    transform: translateX(20px);
  }
  .row.level {
    padding-left: 58px;
  }
  .level-slider {
    flex: 1;
    min-width: 0;
  }
  /* iOS segmented control */
  .segmented {
    display: flex;
    flex-shrink: 0;
    padding: 2px;
    border-radius: 999px;
    background: var(--fill);
  }
  .segmented button {
    height: 28px;
    padding: 0 12px;
    border-radius: 999px;
    font-size: 13px;
    font-weight: 500;
    color: var(--text);
    white-space: nowrap;
    transition:
      background-color 0.2s ease,
      box-shadow 0.2s ease;
  }
  /* A segmented control just moves its selection; no press-down like other buttons. */
  .segmented button:active {
    transform: none;
  }
  .segmented button.on {
    /* iOS: white on light, a lighter grey than the track on dark */
    background: #fff;
    box-shadow:
      0 3px 8px rgb(0 0 0 / 0.12),
      0 0 0 0.5px rgb(0 0 0 / 0.04);
  }
  @media (prefers-color-scheme: dark) {
    .segmented button.on {
      background: #636366;
    }
  }
  @media (max-width: 560px) {
    .row.engine {
      flex-wrap: wrap;
    }
    .row.engine .segmented {
      /* the full row under the text, not 44px past the right edge */
      flex: 1 0 calc(100% - 44px);
      margin-left: 44px;
    }
    .row.engine .segmented button {
      flex: 1;
    }
  }
  .icon-box.lastfm {
    background: #d51007;
    font-size: 13px;
    font-weight: 700;
    letter-spacing: -0.02em;
  }
  .warning {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 14px;
    background: color-mix(in srgb, #ff9500 14%, transparent);
    box-shadow: inset 3px 0 0 #ff9500;
  }
  .warning-mark {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    flex-shrink: 0;
    background: #ff9500;
    color: #fff;
    font-weight: 800;
    font-size: 17px;
  }

  .icon-box.spinning :global(svg) {
    animation: spin 1s linear infinite;
  }
  .text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .label {
    font-size: 15px;
    font-weight: 500;
  }
  .detail {
    font-size: 13px;
    color: var(--text-2);
  }
  .err {
    color: #ff3b30;
  }
  .btn.small {
    min-width: 0;
    height: 30px;
    padding: 0 14px;
    font-size: 13px;
    flex: none !important;
  }
  .btn:disabled {
    opacity: 0.45;
    filter: none;
  }
  .progress {
    height: 3px;
    margin: 0 14px 12px;
    border-radius: 3px;
    overflow: hidden;
    background: var(--fill-strong);
  }
  .progress span {
    display: block;
    height: 100%;
    width: 35%;
    border-radius: 3px;
    background: var(--accent);
    animation: indeterminate 1.3s ease-in-out infinite;
  }
  @keyframes indeterminate {
    from {
      transform: translateX(-100%);
    }
    to {
      transform: translateX(290%);
    }
  }

  dl {
    margin: 0;
    padding: 0 14px 6px 58px;
  }
  dl div {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    padding: 9px 0;
    border-top: 0.5px solid var(--hairline);
    font-size: 14px;
  }
  dt {
    color: var(--text);
  }
  dd {
    margin: 0;
    color: var(--text-2);
    text-align: right;
  }
  .signout {
    max-width: calc(720px + 2 * var(--gutter));
  }
  .signout-btn {
    width: 100%;
    height: 46px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    border-radius: 12px;
    font-size: 16px;
    font-weight: 600;
    color: #ff3b30;
    background: var(--fill);
  }
  .signout-btn:hover {
    background: rgb(255 59 48 / 0.12);
  }
  @keyframes text-in {
    from {
      opacity: 0;
      transform: translateY(8px);
    }
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
