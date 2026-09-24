<script lang="ts">
	import { login, SubsonicError } from '../api';
	import Icon from '../components/Icon.svelte';

	let { onlogin }: { onlogin: () => void } = $props();

	let server = $state('https://music.hungtp.ninja/subsonic');
	let username = $state('');
	let password = $state('');
	let apiKey = $state('');
	let mode = $state<'password' | 'apiKey'>('password');
	let busy = $state(false);
	let error = $state('');

	const messages: Record<number, string> = {
		40: 'Wrong username or app password.',
		41: 'This server doesn’t accept token authentication.',
		44: 'That API key isn’t valid.'
	};

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		error = '';
		try {
			await login(mode === 'apiKey' ? { server, apiKey } : { server, username, password });
			onlogin();
		} catch (err) {
			if (err instanceof SubsonicError) error = messages[err.code] ?? err.message;
			else error = 'Couldn’t reach the server. Check the address (and CORS, if it’s on another domain).';
		} finally {
			busy = false;
		}
	}
</script>

<div class="login">
	<form class="card" onsubmit={submit}>
		<div class="logo"><Icon name="note" size={36} /></div>
		<h1>Sign in to hify</h1>
		<p class="muted">Connect to your hify or any OpenSubsonic server.</p>

		<label>
			<span>Server</span>
			<input type="url" bind:value={server} placeholder="https://music.example.com" required autocomplete="url" />
		</label>

		<div class="seg" role="tablist">
			<button type="button" role="tab" aria-selected={mode === 'password'} class:on={mode === 'password'} onclick={() => (mode = 'password')}>App Password</button>
			<button type="button" role="tab" aria-selected={mode === 'apiKey'} class:on={mode === 'apiKey'} onclick={() => (mode = 'apiKey')}>API Key</button>
		</div>

		{#if mode === 'password'}
			<label>
				<span>Username</span>
				<input bind:value={username} required autocomplete="username" autocapitalize="none" spellcheck="false" />
			</label>
			<label>
				<span>App password</span>
				<input type="password" bind:value={password} required autocomplete="current-password" />
			</label>
			<p class="hint">In hify, create one under Profile → Connect Apps.</p>
		{:else}
			<label>
				<span>API key</span>
				<input type="password" bind:value={apiKey} required autocomplete="off" />
			</label>
		{/if}

		{#if error}<p class="error" role="alert">{error}</p>{/if}

		<button class="btn submit" type="submit" disabled={busy}>{busy ? 'Signing In…' : 'Sign In'}</button>
	</form>
</div>

<style>
	.login {
		min-height: 100%;
		display: grid;
		place-items: center;
		padding: 24px 16px;
		background:
			radial-gradient(1200px 600px at 10% -10%, rgb(250 45 72 / 0.18), transparent 60%),
			radial-gradient(900px 500px at 110% 110%, rgb(120 90 255 / 0.15), transparent 60%),
			var(--bg);
	}
	.card {
		width: min(400px, 100%);
		display: flex;
		flex-direction: column;
		gap: 14px;
		padding: 32px 28px 28px;
		border-radius: 20px;
		background: var(--bg-elevated);
		box-shadow:
			0 20px 60px rgb(0 0 0 / 0.12),
			0 0 0 0.5px var(--hairline);
	}
	.logo {
		width: 64px;
		height: 64px;
		margin: 0 auto 4px;
		border-radius: 15px;
		display: grid;
		place-items: center;
		color: #fff;
		background: linear-gradient(#fb5c74, #fa233b);
		box-shadow: 0 8px 20px rgb(250 35 59 / 0.35);
	}
	h1 {
		margin: 0;
		text-align: center;
		font-size: 24px;
		letter-spacing: -0.02em;
	}
	.card > p.muted {
		margin: -6px 0 4px;
		text-align: center;
		font-size: 14px;
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 5px;
		font-size: 12px;
		font-weight: 600;
		color: var(--text-2);
	}
	input {
		height: 40px;
		padding: 0 12px;
		border-radius: 10px;
		border: 0;
		font: inherit;
		font-size: 15px;
		font-weight: 400;
		color: var(--text);
		background: var(--fill);
		outline: none;
	}
	input:focus {
		box-shadow: 0 0 0 3px var(--accent-soft), inset 0 0 0 1px var(--accent);
	}
	.seg {
		display: grid;
		grid-template-columns: 1fr 1fr;
		padding: 2px;
		border-radius: 9px;
		background: var(--fill);
	}
	.seg button {
		height: 28px;
		border-radius: 7px;
		font-size: 13px;
		font-weight: 500;
		color: var(--text-2);
	}
	.seg button.on {
		color: var(--text);
		background: var(--bg-elevated);
		box-shadow: 0 1px 4px rgb(0 0 0 / 0.12);
	}
	.hint {
		margin: -6px 0 0;
		font-size: 12px;
		color: var(--text-3);
	}
	.error {
		margin: 0;
		padding: 10px 12px;
		border-radius: 10px;
		font-size: 13px;
		color: #d70015;
		background: rgb(255 59 48 / 0.1);
	}
	.submit {
		height: 44px;
		margin-top: 6px;
		border-radius: 12px;
		font-size: 16px;
	}
	.submit:disabled {
		opacity: 0.6;
	}
</style>
