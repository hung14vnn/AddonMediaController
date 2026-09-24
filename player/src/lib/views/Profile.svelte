<script lang="ts">
	import {
		getScanStatus,
		getServerInfo,
		getSession,
		SubsonicError,
		startScan,
		type ScanStatus,
		type ServerInfo
	} from '../api';
	import Avatar from '../components/Avatar.svelte';
	import Icon from '../components/Icon.svelte';
	import { plural } from '../format';
	import { ui } from '../ui.svelte';

	let { onsignout }: { onsignout: () => void } = $props();

	const session = getSession();
	const host = (() => {
		try {
			return new URL(session?.base ?? '', location.href).host;
		} catch {
			return session?.base ?? '';
		}
	})();

	let server = $state<ServerInfo | null>(null);
	let scan = $state<ScanStatus | null>(null);
	let scanError = $state('');
	let starting = $state(false);
	let pollTimer: ReturnType<typeof setTimeout> | undefined;

	getServerInfo()
		.then((s) => (server = s))
		.catch(() => {});
	if (!ui.me) ui.loadMe();

	async function refreshScan(wasScanning = false) {
		try {
			scan = await getScanStatus();
			scanError = '';
		} catch (e) {
			scanError = e instanceof Error ? e.message : 'Couldn’t read scan status';
			return;
		}
		clearTimeout(pollTimer);
		if (scan.scanning) pollTimer = setTimeout(() => refreshScan(true), 2000);
		else if (wasScanning) ui.showToast('Library scan finished');
	}

	async function rescan() {
		starting = true;
		scanError = '';
		try {
			scan = await startScan();
			ui.showToast('Library scan started');
			refreshScan(true);
		} catch (e) {
			scanError =
				e instanceof SubsonicError && e.code === 50
					? 'Only administrators can start a library scan.'
					: e instanceof Error
						? e.message
						: 'Couldn’t start the scan';
		} finally {
			starting = false;
		}
	}

	refreshScan();
	$effect(() => () => clearTimeout(pollTimer));

	let cacheCleared = $state(false);
	async function clearArtCache() {
		try {
			const keys = await caches.keys();
			await Promise.all(keys.filter((k) => k.startsWith('art-')).map((k) => caches.delete(k)));
			cacheCleared = true;
			ui.showToast('Artwork cache cleared');
		} catch {
			ui.showToast('Couldn’t clear the cache');
		}
	}

	function signOut() {
		if (confirm('Sign out of hify? Your queue on this device will be cleared.')) onsignout();
	}

	const displayName = $derived(ui.me?.username ?? session?.username ?? 'Account');
	const isAdmin = $derived(!!ui.me?.adminRole);
</script>

<div class="page">
	<h1 class="page-title">Account</h1>

	<section class="hero pad">
		<Avatar username={ui.me?.username ?? session?.username} size={84} />
		<div class="who">
			<h2>{displayName}</h2>
			<div class="badges">
				{#if isAdmin}<span class="badge accent">Administrator</span>{/if}
				<span class="badge">{session?.apiKey ? 'API key' : 'App password'}</span>
			</div>
			<span class="muted host">{host}</span>
		</div>
	</section>

	<h3 class="group-title">Library</h3>
	<div class="group">
		<div class="row">
			<span class="icon-box scan" class:spinning={scan?.scanning}><Icon name="refresh" size={18} /></span>
			<div class="text">
				<span class="label">Library Scan</span>
				<span class="detail">
					{#if scanError}
						<span class="err">{scanError}</span>
					{:else if !scan}
						Checking…
					{:else if scan.scanning}
						Scanning{#if scan.count}&nbsp;· {plural(scan.count, 'item').replace(String(scan.count), scan.count.toLocaleString())}{/if}…
					{:else}
						Up to date{#if scan.count}&nbsp;· {plural(scan.count, 'item').replace(String(scan.count), scan.count.toLocaleString())}{/if}
					{/if}
				</span>
			</div>
			<button
				class="btn small"
				disabled={starting || !!scan?.scanning || (!!ui.me && !isAdmin)}
				onclick={rescan}
				title={ui.me && !isAdmin ? 'Only administrators can start a scan' : undefined}
			>
				{scan?.scanning ? 'Scanning…' : starting ? 'Starting…' : 'Rescan'}
			</button>
		</div>
		{#if scan?.scanning}
			<div class="progress" aria-hidden="true"><span></span></div>
		{/if}
		{#if ui.me && !isAdmin}
			<p class="note">Only administrators can start a scan. New music still appears automatically when the server scans.</p>
		{/if}
	</div>

	<h3 class="group-title">Server</h3>
	<div class="group">
		<div class="row">
			<span class="icon-box"><Icon name="server" size={18} /></span>
			<div class="text">
				<span class="label">{server?.type ?? 'Subsonic server'}</span>
				<span class="detail">{host}</span>
			</div>
		</div>
		<dl>
			{#if server?.serverVersion}<div><dt>Server version</dt><dd>{server.serverVersion}</dd></div>{/if}
			{#if server?.version}<div><dt>API version</dt><dd>{server.version}{#if server.openSubsonic}&nbsp;· OpenSubsonic{/if}</dd></div>{/if}
			{#if ui.me?.maxBitRate}<div><dt>Max bitrate</dt><dd>{ui.me.maxBitRate} kbps</dd></div>{/if}
			<div><dt>Scrobbling</dt><dd>{ui.me?.scrobblingEnabled === false ? 'Off' : 'On'}</dd></div>
		</dl>
	</div>

	<h3 class="group-title">Storage</h3>
	<div class="group">
		<div class="row">
			<span class="icon-box"><Icon name="album" size={18} /></span>
			<div class="text">
				<span class="label">Artwork Cache</span>
				<span class="detail">Cover art saved for offline use on this device.</span>
			</div>
			<button class="btn small secondary" disabled={cacheCleared} onclick={clearArtCache}>{cacheCleared ? 'Cleared' : 'Clear'}</button>
		</div>
	</div>

	<div class="pad signout">
		<button class="signout-btn" onclick={signOut}><Icon name="signOut" size={18} />Sign Out</button>
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
	.note {
		margin: 0;
		padding: 0 14px 12px 58px;
		font-size: 12px;
		color: var(--text-2);
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
