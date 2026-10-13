use topcoat::{
    Result,
    asset::{AssetBundle, RouterBuilderAssetExt, asset},
    icon::{IconData, icon},
    router::{Slot, layout, module_router, page},
    tailwind,
    view::{View, component, svg::ViewBox, view},
};

#[tokio::main]
async fn main() {
    let router = module_router!()
        .assets(AssetBundle::load().unwrap())
        .build();
    topcoat::start(router).await.unwrap();
}

#[layout]
async fn root_layout(slot: Slot<'_>) -> Result<impl View> {
    Ok(view! {
        <!DOCTYPE html>
        <html lang="en">
            <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <title>"begihup"</title>
                // Blocking on purpose: sets the theme before first paint to avoid a flash.
                <script src=(asset!("./theme.js"))></script>
                <link rel="stylesheet" href=(tailwind::stylesheet!())>
                topcoat::dev::script()
            </head>
            <body class="min-h-screen bg-white text-zinc-900 antialiased dark:bg-zinc-950 dark:text-zinc-100">
                <header class="flex items-center justify-between border-b border-zinc-200 px-6 py-3 dark:border-zinc-800">
                    <span class="font-semibold">"begihup"</span>
                    theme_switch()
                </header>
                <main class="mx-auto max-w-3xl px-6 py-12">
                    (slot)
                </main>
            </body>
        </html>
    })
}

#[page]
async fn home() -> Result<impl View> {
    Ok(view! {
        hello(name: "World")
    })
}

#[component]
async fn hello(name: &str) -> Result<impl View> {
    Ok(view! {
        <h1 class="text-3xl font-bold tracking-tight">"Hello, " (name) "!"</h1>
        <p class="mt-2 text-zinc-600 dark:text-zinc-400">"Use the switch in the top right to change the theme."</p>
    })
}

const SUN: IconData = IconData::unescaped_unchecked(
    ViewBox::new(0.0, 0.0, 24.0, 24.0),
    r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></g>"#,
);

const MOON: IconData = IconData::unescaped_unchecked(
    ViewBox::new(0.0, 0.0, 24.0, 24.0),
    r#"<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>"#,
);

const MONITOR: IconData = IconData::unescaped_unchecked(
    ViewBox::new(0.0, 0.0, 24.0, 24.0),
    r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8M12 17v4"/></g>"#,
);

/// Light / dark / system toggle. Behaviour lives in `theme.js`.
#[component]
async fn theme_switch() -> Result<impl View> {
    Ok(view! {
        <div role="group" aria-label="Theme" class="inline-flex gap-1 rounded-lg border border-zinc-200 p-1 dark:border-zinc-800">
            theme_button(choice: "light", label: "Light", data: SUN)
            theme_button(choice: "dark", label: "Dark", data: MOON)
            theme_button(choice: "system", label: "System", data: MONITOR)
        </div>
    })
}

#[component]
async fn theme_button(choice: &str, label: &str, data: IconData) -> Result<impl View> {
    Ok(view! {
        <button
            type="button"
            data-theme-choice=(choice)
            aria-pressed="false"
            title=(label)
            class="rounded-md p-1.5 text-zinc-500 hover:text-zinc-900 aria-pressed:bg-zinc-100 aria-pressed:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 dark:aria-pressed:bg-zinc-800 dark:aria-pressed:text-zinc-100"
        >
            icon(data: data, label: label)
        </button>
    })
}
