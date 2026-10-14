import type { Detail } from '#lib/types.ts';

declare global {
	namespace App {
		interface PageState {
			selected?: { issue: Detail };
		}
	}
}

export {};
