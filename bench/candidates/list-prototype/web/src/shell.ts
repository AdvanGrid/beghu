// PROTOTYPE (beghu #54). What the detail needs from the list shell, without threading context:
// the loaded rows, for stepping to the next and previous issue.
import type { IssueRow } from './api';

export const shell = { rows: (): IssueRow[] => [] };
