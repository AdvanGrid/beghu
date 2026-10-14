<script lang="ts">
	import type { Label } from './types';

	let { label, bench }: { label: Label; bench?: string } = $props();

	// Dark text on light label colours, light text on dark ones, as GitHub does.
	const dark = $derived.by(() => {
		const n = parseInt(label.color, 16);
		return ((n >> 16) * 299 + ((n >> 8) & 255) * 587 + (n & 255) * 114) / 1000 > 140;
	});
</script>

<span
	data-bench={bench}
	data-value={label.name}
	class="rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap"
	style:background-color="#{label.color}"
	style:color={dark ? '#18181b' : '#fafafa'}>{label.name}</span
>
