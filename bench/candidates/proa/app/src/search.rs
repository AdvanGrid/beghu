//! The search box island.
use proa_core::{DataLoader, WebContext, WebRenderSync, WriteError};
use proa_macros::html_sync;
use rsjs::rsjs;

/// Submits its GET form on every keystroke; Turbo Drive turns that into a visit. The form sits in
/// a `data-turbo-permanent` wrapper so the input (focus, caret, typed text) survives each visit,
/// and the current filters ride along as hidden inputs in the page body (`form="search-form"`).
pub struct SearchBox {
    pub q: String,
}

#[rsjs(component, client)]
impl<L: DataLoader> WebRenderSync<L> for SearchBox {
    fn render(self, cx: &mut WebContext<L>) -> Result<(), WriteError> {
        let form = rsjs::node_ref::<rsjs::HtmlFormElement>();
        let submit = rsjs::event_handler(|_: rsjs::InputEvent<rsjs::elem::Input>| {
            form.request_submit();
        });
        let q = self.q;
        html_sync! {
            <form id="search-form" ref={form} action="/" method="get" data-turbo-action={crate::opts::OPTS.filter_action} data-turbo-frame={crate::opts::OPTS.search_target}>
                <input
                    data-bench="search"
                    type="search"
                    name="q"
                    value={q}
                    autocomplete="off"
                    autofocus={crate::opts::OPTS.refocus_search}
                    placeholder="Search titles"
                    on_input={submit()}
                />
            </form>
        }
        .render(cx)
    }
}

