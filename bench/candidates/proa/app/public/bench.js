// Bench glue, not app code: the harness contract wants `data-bench-ready` once rows are
// clickable. Here that means Turbo Drive has started, so a click is a visit, not a full load.
const ready = () => document.querySelector('[data-bench=list]')?.setAttribute('data-bench-ready', '');
document.addEventListener('turbo:load', ready);
document.addEventListener('turbo:morph', ready);
document.addEventListener('turbo:frame-load', ready);
