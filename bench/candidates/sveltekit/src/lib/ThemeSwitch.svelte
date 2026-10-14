<script lang="ts">
	import { onMount } from 'svelte';

	type Theme = 'light' | 'dark' | 'system';
	let theme = $state<Theme>('system');

	onMount(() => {
		try {
			theme = (localStorage.getItem('theme') as Theme) ?? 'system';
		} catch {}
		const media = matchMedia('(prefers-color-scheme: dark)');
		const apply = () =>
			document.documentElement.classList.toggle('dark', theme === 'dark' || (theme === 'system' && media.matches));
		media.addEventListener('change', apply);
		return () => media.removeEventListener('change', apply);
	});

	function set(t: Theme) {
		theme = t;
		try {
			localStorage.setItem('theme', t);
		} catch {}
		const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
		document.documentElement.classList.toggle('dark', dark);
	}
</script>

<div class="flex rounded border border-zinc-300 text-xs dark:border-zinc-700">
	{#each ['light', 'dark', 'system'] as const as t (t)}
		<button
			type="button"
			aria-pressed={theme === t}
			onclick={() => set(t)}
			class="px-2 py-1 text-zinc-600 aria-pressed:bg-zinc-200 aria-pressed:text-zinc-900 dark:text-zinc-400 dark:aria-pressed:bg-zinc-800 dark:aria-pressed:text-zinc-100"
			>{t}</button
		>
	{/each}
</div>
