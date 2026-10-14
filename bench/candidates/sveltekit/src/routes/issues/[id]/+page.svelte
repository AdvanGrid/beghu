<script lang="ts">
	import Detail from '#lib/Detail.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<main class="mx-auto max-w-3xl p-4">
	<a href="/" class="text-sm text-blue-700 dark:text-blue-400">← All issues</a>
	<Detail issue={data.issue} />
</main>
