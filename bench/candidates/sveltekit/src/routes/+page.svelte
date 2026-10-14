<script lang="ts">
	import { onMount } from 'svelte';
	import { goto, invalidate, preloadData } from '$app/navigation';
	import { page } from '$app/state';
	import Detail from '#lib/Detail.svelte';
	import LabelChip from '#lib/LabelChip.svelte';
	import ThemeSwitch from '#lib/ThemeSwitch.svelte';
	import { PAGE, filterToParams, type Detail as Issue, type Filter, type Row } from '#lib/types.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// Pages loaded on scroll. A new first page (filter change, live update) starts them over.
	let extra = $derived<Row[]>((data.rows, []));
	let exhausted = $derived(data.rows.length < PAGE);
	let loading = false;
	const rows = $derived.by(() => {
		const seen = new Set(data.rows.map((r) => r.id));
		return [...data.rows, ...extra.filter((r) => !seen.has(r.id))];
	});

	let hydrated = $state(false);

	const href = (f: Filter) => {
		const p = filterToParams(f).toString();
		return p ? `/?${p}` : '/';
	};
	const toggled = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

	async function loadMore() {
		if (loading || exhausted) return;
		loading = true;
		const first = data.rows;
		const p = filterToParams(data.filter);
		p.set('offset', String(rows.length));
		const more: Row[] = await fetch(`/api/issues?${p}`).then((r) => r.json());
		loading = false;
		if (first !== data.rows) return;
		extra = [...extra, ...more];
		exhausted = more.length < PAGE;
	}

	// Re-attaches whenever the list grows, so a sentinel still in range asks for the next page.
	function sentinel(node: HTMLElement) {
		void rows.length;
		const io = new IntersectionObserver(([e]) => e.isIntersecting && loadMore(), { rootMargin: '600px' });
		io.observe(node);
		return () => io.disconnect();
	}

	async function openDetail(e: MouseEvent, id: string) {
		if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
		e.preventDefault();
		const to = `/issues/${id}`;
		const result = await preloadData(to);
		if (result.type === 'loaded' && result.status === 200) {
			await goto(to, { shallow: true, state: { selected: result.data as { issue: Issue } } });
		} else await goto(to);
	}

	async function refreshDetail(id: string) {
		const result = await preloadData(`/issues/${id}`);
		if (result.type === 'loaded' && page.state.selected?.issue.id === id) {
			await goto(`/issues/${id}`, { shallow: true, replace: true, state: { selected: result.data as { issue: Issue } } });
		}
	}

	onMount(() => {
		hydrated = true;
		const events = new EventSource('/events');
		events.onmessage = (e) => {
			const { ids } = JSON.parse(e.data) as { ids: string[] };
			invalidate('app:issues', true);
			const open = page.state.selected?.issue.id;
			if (open && ids.includes(open)) refreshDetail(open);
		};
		return () => events.close();
	});

	const chip =
		'rounded border px-2 py-0.5 text-xs border-zinc-300 text-zinc-700 hover:bg-zinc-100 aria-pressed:border-blue-600 aria-pressed:bg-blue-600 aria-pressed:text-white dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:aria-pressed:border-blue-500 dark:aria-pressed:bg-blue-500 dark:aria-pressed:text-white';
</script>

<svelte:head><title>beghu · SvelteKit</title></svelte:head>

<header
	class="sticky top-0 z-10 space-y-2 border-b border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950"
	data-sveltekit-keepfocus
	data-sveltekit-noscroll
	data-sveltekit-replacestate
>
	<div class="flex items-center gap-2">
		{#each ['open', 'closed'] as const as s (s)}
			<a
				href={href({ ...data.filter, state: s })}
				role="button"
				aria-pressed={data.filter.state === s}
				data-bench="filter-state"
				data-value={s}
				class={chip}>{s}</a
			>
		{/each}
		<input
			data-bench="search"
			type="search"
			placeholder="Search titles"
			autocomplete="off"
			value={data.filter.q}
			oninput={(e) => goto(href({ ...data.filter, q: e.currentTarget.value }), { reset: false, replace: true })}
			class="flex-1 rounded border border-zinc-300 bg-white px-2 py-1 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
		/>
		<ThemeSwitch />
	</div>
	<div class="flex flex-wrap gap-1">
		{#each data.facets.labels as l (l)}
			<a
				href={href({ ...data.filter, labels: toggled(data.filter.labels, l) })}
				role="button"
				aria-pressed={data.filter.labels.includes(l)}
				data-bench="filter-label"
				data-value={l}
				class={chip}>{l}</a
			>
		{/each}
	</div>
	<div class="flex flex-wrap gap-1">
		{#each data.facets.assignees as a (a)}
			<a
				href={href({ ...data.filter, assignees: toggled(data.filter.assignees, a) })}
				role="button"
				aria-pressed={data.filter.assignees.includes(a)}
				data-bench="filter-assignee"
				data-value={a}
				class={chip}>@{a}</a
			>
		{/each}
	</div>
</header>

<div class="flex">
	<ul
		data-bench="list"
		data-bench-ready={hydrated ? '' : undefined}
		data-bench-empty={rows.length === 0 ? '' : undefined}
		class="min-w-0 flex-1 divide-y divide-zinc-100 dark:divide-zinc-900"
	>
		{#each rows as row (row.id)}
			<li>
				<a
					href="/issues/{row.id}"
					data-bench="row"
					data-id={row.id}
					onclick={(e) => openDetail(e, row.id)}
					data-sveltekit-preload-data="false"
					class="flex items-center gap-2 px-3 py-2 text-sm hover:bg-zinc-50 aria-current:bg-blue-50 dark:hover:bg-zinc-900 dark:aria-current:bg-blue-950"
					aria-current={page.state.selected?.issue.id === row.id ? 'true' : undefined}
				>
					<span class="w-28 shrink-0 truncate text-xs text-zinc-500 dark:text-zinc-400">{row.repo}#{row.number}</span>
					<span data-bench="title" class="min-w-0 truncate text-zinc-900 dark:text-zinc-100">{row.title}</span>
					<span class="flex shrink-0 gap-1">
						{#each row.labels as label (label.name)}
							<LabelChip {label} />
						{/each}
					</span>
					<span class="ml-auto shrink-0 text-xs text-zinc-500 dark:text-zinc-400">
						{row.assignees.map((a) => `@${a}`).join(' ')}
						{#if row.comments_count}· {row.comments_count} 💬{/if}
					</span>
				</a>
			</li>
		{:else}
			<li class="p-6 text-sm text-zinc-500 dark:text-zinc-400">No issues match.</li>
		{/each}
		{#if !exhausted}
			<li {@attach sentinel} class="p-3 text-xs text-zinc-400 dark:text-zinc-600">Loading more…</li>
		{/if}
	</ul>

	{#if page.state.selected}
		<aside
			class="sticky top-28 h-[calc(100vh-7rem)] w-[45%] shrink-0 overflow-y-auto border-l border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950"
		>
			<Detail issue={page.state.selected.issue} onclose={() => history.back()} />
		</aside>
	{/if}
</div>
