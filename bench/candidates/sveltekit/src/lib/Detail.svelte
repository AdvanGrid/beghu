<script lang="ts">
	import { enhance } from '$app/forms';
	import LabelChip from './LabelChip.svelte';
	import type { Detail } from './types';

	let { issue, onclose }: { issue: Detail; onclose?: () => void } = $props();

	// Labels added here that the server hasn't confirmed yet. Cleared when another issue opens.
	let pending = $derived<string[]>((issue.id, []));
	const labels = $derived([
		...issue.labels,
		...issue.repo_labels.filter((l) => pending.includes(l.name) && !issue.labels.some((h) => h.name === l.name))
	]);
	const addable = $derived(issue.repo_labels.filter((l) => !labels.some((h) => h.name === l.name)));
</script>

<article data-bench="detail" data-id={issue.id} class="space-y-4">
	<header class="flex items-start gap-3">
		<h2 class="flex-1 text-lg font-semibold text-zinc-900 dark:text-zinc-100">
			<span class="font-normal text-zinc-500 dark:text-zinc-400">{issue.repo}#{issue.number}</span>
			{issue.title}
		</h2>
		{#if onclose}
			<button
				type="button"
				onclick={onclose}
				class="rounded px-2 py-1 text-sm text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800">Close</button
			>
		{/if}
	</header>

	<div class="flex flex-wrap gap-1">
		{#each labels as label (label.name)}
			<LabelChip {label} bench="label" />
		{/each}
	</div>

	<form
		method="POST"
		action="/?/addLabel"
		class="flex flex-wrap items-center gap-1 text-xs text-zinc-500 dark:text-zinc-400"
		use:enhance={({ formData }) => {
			const name = String(formData.get('name'));
			pending = [...pending, name];
			return async ({ result }) => {
				if (result.type !== 'success') pending = pending.filter((n) => n !== name);
			};
		}}
	>
		<input type="hidden" name="id" value={issue.id} />
		Add:
		{#each addable as label (label.name)}
			<button
				name="name"
				value={label.name}
				data-bench="add-label"
				data-value={label.name}
				class="rounded border border-zinc-300 px-1.5 py-0.5 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800">{label.name}</button
			>
		{/each}
	</form>

	<pre
		data-bench="body"
		class="font-sans text-sm whitespace-pre-wrap text-zinc-800 dark:text-zinc-200">{issue.body}</pre>

	<section class="space-y-3">
		{#each issue.comments as comment (comment.id)}
			<!-- Off-screen comments skip layout and paint until scrolled to. -->
			<div data-bench="comment" class="[contain-intrinsic-size:auto_160px] [content-visibility:auto] rounded border border-zinc-200 p-3 dark:border-zinc-800">
				<div class="mb-1 text-xs text-zinc-500 dark:text-zinc-400">{comment.author} · {comment.created_at}</div>
				<pre class="font-sans text-sm whitespace-pre-wrap text-zinc-800 dark:text-zinc-200">{comment.body}</pre>
			</div>
		{/each}
	</section>
</article>
