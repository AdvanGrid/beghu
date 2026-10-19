//! The detail's label editor island (async: it declares a mutation).
use std::future::Future;

use proa_core::{DataLoader, RenderOutcome, WebContext, WebRender, WriteError};
use proa_macros::html;
use rsjs::{rsjs, signal, QueryKey};

pub struct LabelOption {
    pub name: String,
    /// The mutation payload, `"<issue id>\t<label name>"`: a `FetchRequest` URL is static.
    pub key: String,
    pub had: bool,
}

/// Label chips plus an add button per missing label. The chip shows at once (a signal); the
/// mutation posts the write.
pub struct AddLabels {
    pub options: Vec<LabelOption>,
}

#[rsjs(component, client)]
impl<L: DataLoader> WebRender<L> for AddLabels {
    fn render(self, cx: &mut WebContext<L>) -> RenderOutcome<impl Future<Output = Result<(), WriteError>>> {
        RenderOutcome::pending(async move {
            let added = signal(String::new());
            let save = rsjs::mutation::<String, ()>(
                QueryKey::new(("labels", "add")),
                rsjs::FetchRequest {
                    url: "/api/labels",
                    method: Some(rsjs::HttpMethod::Post),
                    response: Some(rsjs::ResponseKind::Empty),
                    ..Default::default()
                },
                &[],
            );
            let add = rsjs::event_handler(|_: rsjs::MouseEvent<rsjs::elem::Button>, key: String| {
                added.set(key);
                save.run(added.get());
            });
            html! {
                <section class="labels">
                    <div class="chips">
                        {for o in self.options.iter() {
                            html! {
                                <span
                                    class="chip"
                                    data-bench={if o.had || added.get() == o.key { "label" } else { "label-off" }}
                                    data-value={o.name.as_str()}
                                    hidden={!(o.had || added.get() == o.key)}
                                >
                                    {o.name.as_str()}
                                </span>
                            }
                        }}
                    </div>
                    <div class="add">
                        {for o in self.options.iter() {
                            html! {
                                <button type="button" class="toggle" data-bench="add-label" data-value={o.name.as_str()} on_click={add(o.key.clone())}>
                                    "+ "{o.name.as_str()}
                                </button>
                            }
                        }}
                    </div>
                </section>
            }
            .render(cx)
            .resolve()
            .await
        })
    }
}
