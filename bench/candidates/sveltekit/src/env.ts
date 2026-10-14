import { defineEnvVars } from '@sveltejs/kit/env';

export const variables = defineEnvVars({
	MIRROR_PATH: {
		description: 'The SQLite mirror the harness mounts',
		schema: (value) => value ?? '/data/mirror.db'
	},
	GITHUB_LATENCY_MS: {
		description: 'How long a write waits, standing in for the GitHub API',
		schema: (value) => Number(value ?? 300)
	}
});
