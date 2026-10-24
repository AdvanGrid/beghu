// Throwaway: `spec` renders ../spec/tests.json with each crate; `bench <corpus.json>` times them.
use std::time::Instant;

fn comrak_opts() -> comrak::Options<'static> {
    let mut o = comrak::Options::default();
    o.extension.strikethrough = true;
    o.extension.table = true;
    o.extension.autolink = true;
    o.extension.tasklist = true;
    o.extension.alerts = true;
    o.render.gfm_quirks = true;
    o.extension.footnotes = true;
    o.render.r#unsafe = true; // raw HTML passes; ammonia sanitises after
    o
}
fn comrak(s: &str) -> String { comrak::markdown_to_html(s, &comrak_opts()) }
fn pulldown(s: &str) -> String {
    use pulldown_cmark::{Options, Parser, html};
    let o = Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS | Options::ENABLE_FOOTNOTES | Options::ENABLE_GFM;
    let mut out = String::new();
    html::push_html(&mut out, Parser::new_ext(s, o));
    out
}
fn mdrs(s: &str) -> String {
    let mut o = markdown::Options::gfm();
    o.compile.allow_dangerous_html = true;
    o.compile.allow_dangerous_protocol = true;
    markdown::to_html_with_options(s, &o).unwrap()
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let fs: [(&str, fn(&str) -> String); 3] = [("comrak", comrak), ("pulldown-cmark", pulldown), ("markdown-rs", mdrs)];
    match a[1].as_str() {
        "spec" => {
            let t: Vec<serde_json::Value> = serde_json::from_str(&std::fs::read_to_string("../spec/tests.json").unwrap()).unwrap();
            for (n, f) in fs {
                let out: Vec<String> = t.iter().map(|x| f(x["markdown"].as_str().unwrap())).collect();
                std::fs::write(format!("../spec/out-{n}.json"), serde_json::to_string(&out).unwrap()).unwrap();
            }
        }
        "bench" => {
            let docs: Vec<String> = serde_json::from_str(&std::fs::read_to_string(&a[2]).unwrap()).unwrap();
            let bytes: usize = docs.iter().map(|d| d.len()).sum();
            for (n, f) in fs {
                let mut best = f64::MAX; let mut outb = 0;
                for _ in 0..20 { let t = Instant::now(); outb = docs.iter().map(|d| f(d).len()).sum(); best = best.min(t.elapsed().as_secs_f64()); }
                println!("{n:15} {:.2} ms for {} docs / {} KB md -> {} KB html  ({:.1} MB/s)", best * 1e3, docs.len(), bytes / 1024, outb / 1024, bytes as f64 / best / 1e6);
            }
            let html: Vec<String> = docs.iter().map(|d| comrak(d)).collect();
            let mut best = f64::MAX;
            for _ in 0..20 { let t = Instant::now(); for h in &html { std::hint::black_box(ammonia::clean(h)); } best = best.min(t.elapsed().as_secs_f64()); }
            println!("ammonia::clean on comrak html: {:.2} ms", best * 1e3);
        }
        "render" => {
            // docs JSON (strings) -> comrak HTML sanitised by ammonia with its default allowlist
            // plus the task-list checkbox, JSON array on stdout.
            let docs: Vec<String> = serde_json::from_str(&std::fs::read_to_string(&a[2]).unwrap()).unwrap();
            let mut b = ammonia::Builder::default();
            b.add_tags(["input"]).add_tag_attributes("input", ["type", "checked", "disabled"])
             .add_tag_attributes("code", ["class"]).add_tag_attributes("div", ["class"]).add_tag_attributes("p", ["class"])
             .add_tag_attributes("li", ["id"]).add_tag_attributes("sup", ["class"]).add_tag_attributes("section", ["class"])
             .add_tags(["section"]).add_tag_attributes("a", ["id", "class"]).add_tag_attributes("pre", ["lang"]);
            let out: Vec<String> = docs.iter().map(|d| b.clean(&comrak(d)).to_string()).collect();
            println!("{}", serde_json::to_string(&out).unwrap());
        }
        "hl" => {
            // syntect, class-based spans (ClassedHTMLGenerator), over [lang, code] pairs.
            use syntect::{html::{ClassedHTMLGenerator, ClassStyle}, parsing::SyntaxSet, util::LinesWithEndings};
            let t = Instant::now();
            let ss = SyntaxSet::load_defaults_newlines();
            println!("syntect: load default syntaxes {:.1} ms, {} syntaxes", t.elapsed().as_secs_f64() * 1e3, ss.syntaxes().len());
            let blocks: Vec<(String, String)> = serde_json::from_str(&std::fs::read_to_string(&a[2]).unwrap()).unwrap();
            let mut best = f64::MAX; let (mut n, mut out) = (0, 0);
            for _ in 0..5 {
                let t = Instant::now(); n = 0; out = 0;
                for (l, c) in &blocks {
                    let Some(syn) = ss.find_syntax_by_token(l) else { continue };
                    let mut g = ClassedHTMLGenerator::new_with_class_style(syn, &ss, ClassStyle::SpacedPrefixed { prefix: "s-" });
                    for line in LinesWithEndings::from(c) { g.parse_html_for_line_which_includes_newline(line).unwrap(); }
                    out += g.finalize().len(); n += 1;
                }
                best = best.min(t.elapsed().as_secs_f64());
            }
            println!("syntect: {n} blocks highlighted in {:.1} ms, {} KB html", best * 1e3, out / 1024);
        }
        _ => {}
    }
}
