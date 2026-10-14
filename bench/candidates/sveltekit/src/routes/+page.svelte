<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { goto, preloadData } from '$app/navigation';
	import { page } from '$app/state';
	import Detail from '#lib/Detail.svelte';
	import LabelChip from '#lib/LabelChip.svelte';
	import ThemeSwitch from '#lib/ThemeSwitch.svelte';
	import { MORE, PAGE, filterToParams, type Detail as Issue, type Filter, type Row } from '#lib/types.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// The load function renders the first page on the server. After that the page fetches rows
	// itself, so a filter change costs one JSON request instead of a router navigation.
	let filter = $state(untrack(() => data.filter));
	let first = $state<Row[]>(untrack(() => data.rows));
	let generation = 0;

	// Pages loaded on scroll. A new first page (filter change, live update) starts them over.
	let extra = $derived.by<Row[]>(() => (void first, []));
	let exhausted = $derived(first.length < PAGE);
	let loading = false;
	const rows = $derived.by(() => {
		const seen = new Set(first.map((r) => r.id));
		return [...first, ...extra.filter((r) => !seen.has(r.id))];
	});

	async function fetchRows(f: Filter, offset: number, limit: number): Promise<Row[]> {
		const p = filterToParams(f);
		p.set('offset', String(offset));
		p.set('limit', String(limit));
		return (await fetch(`/api/issues?${p}`)).json();
	}

	async function reload() {
		const gen = ++generation;
		const fresh = await fetchRows(filter, 0, PAGE);
		if (gen === generation) first = fresh;
	}

	function setFilter(e: Event | null, f: Filter) {
		e?.preventDefault();
		filter = f;
		reload();
		// The URL stays shareable without rerunning load. Updated in its own task, while the request
		// is in flight, so the request goes out first.
		setTimeout(() => goto(href(f), { shallow: true, replace: true }));
	}

	let hydrated = $state(false);
	// No page is fetched until the user scrolls, so loading doesn't render a second page.
	let scrolled = $state(false);

	const href = (f: Filter) => {
		const p = filterToParams(f).toString();
		return p ? `/?${p}` : '/';
	};
	const toggled = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

	async function loadMore() {
		if (loading || exhausted) return;
		loading = true;
		const page = first;
		const more = await fetchRows(filter, rows.length, MORE);
		loading = false;
		if (page !== first) return;
		extra = [...extra, ...more];
		exhausted = more.length < MORE;
	}

	// Re-attaches whenever the list grows, so a sentinel still in range asks for the next page.
	function sentinel(node: HTMLElement) {
		void rows.length;
		if (!scrolled) return;
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
			reload();
			const open = page.state.selected?.issue.id;
			if (open && ids.includes(open)) refreshDetail(open);
		};
		return () => events.close();
	});

	const chip =
		'rounded border px-2 py-0.5 text-xs border-zinc-300 text-zinc-700 hover:bg-zinc-100 aria-pressed:border-blue-600 aria-pressed:bg-blue-600 aria-pressed:text-white dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:aria-pressed:border-blue-500 dark:aria-pressed:bg-blue-500 dark:aria-pressed:text-white';
</script>

<svelte:window onscroll={() => (scrolled = true)} />

<svelte:head><title>beghu · SvelteKit</title></svelte:head>

<header
	class="sticky top-0 z-10 space-y-2 border-b border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950"
	data-sveltekit-preload-data="false"
>
	<div class="flex items-center gap-2">
		{#each ['open', 'closed'] as const as s (s)}
			<a
				href={href({ ...filter, state: s })}
				onclick={(e) => setFilter(e, { ...filter, state: s })}
				role="button"
				aria-pressed={filter.state === s}
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
			value={filter.q}
			oninput={(e) => setFilter(null, { ...filter, q: e.currentTarget.value })}
			class="flex-1 rounded border border-zinc-300 bg-white px-2 py-1 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
		/>
		<ThemeSwitch />
	</div>
	<div class="flex flex-wrap gap-1">
		{#each data.facets.labels as l (l)}
			<a
				href={href({ ...filter, labels: toggled(filter.labels, l) })}
				onclick={(e) => setFilter(e, { ...filter, labels: toggled(filter.labels, l) })}
				role="button"
				aria-pressed={filter.labels.includes(l)}
				data-bench="filter-label"
				data-value={l}
				class={chip}>{l}</a
			>
		{/each}
	</div>
	<div class="flex flex-wrap gap-1">
		{#each data.facets.assignees as a (a)}
			<a
				href={href({ ...filter, assignees: toggled(filter.assignees, a) })}
				onclick={(e) => setFilter(e, { ...filter, assignees: toggled(filter.assignees, a) })}
				role="button"
				aria-pressed={filter.assignees.includes(a)}
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
