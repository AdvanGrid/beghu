// Throwaway (beghu thread-size probe). The decided server path for one detail response:
// comrak -> ammonia -> compact AST JSON ([tag, attrs|0, ...kids], text as strings, whitespace-only
// text between blocks dropped). Same comrak options and ammonia allowlist as ../../rs `render`.
//
//   asts <docs.json>          -> JSON array of per-doc compact ASTs on stdout
//   time <thread.json> [reps] -> thread.json is an array of markdown strings; prints median and min
//                                ms for the whole pipeline (and each stage) and the output bytes
use ammonia::rcdom::{Handle, NodeData};
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
    o.render.r#unsafe = true;
    o
}
fn builder() -> ammonia::Builder<'static> {
    let mut b = ammonia::Builder::default();
    b.add_tags(["input"]).add_tag_attributes("input", ["type", "checked", "disabled"])
     .add_tag_attributes("code", ["class"]).add_tag_attributes("div", ["class"]).add_tag_attributes("p", ["class"])
     .add_tag_attributes("li", ["id"]).add_tag_attributes("sup", ["class"]).add_tag_attributes("section", ["class"])
     .add_tags(["section"]).add_tag_attributes("a", ["id", "class"]).add_tag_attributes("pre", ["lang"]);
    b
}
const BLOCK: &[&str] = &["p","ul","ol","li","table","thead","tbody","tr","td","th","blockquote","div","pre","h1","h2","h3","h4","h5","h6","section","details","hr"];

fn esc(out: &mut String, s: &str) { out.push_str(&serde_json::to_string(s).unwrap()); }
fn ws(s: &str) -> bool { s.chars().all(char::is_whitespace) }

// returns false if nothing was written
fn walk(out: &mut String, h: &Handle, in_pre: bool) -> bool {
    match &h.data {
        NodeData::Text { contents } => { esc(out, &contents.borrow()); true }
        NodeData::Element { name, attrs, .. } => {
            let tag: &str = &name.local;
            let pre = in_pre || tag == "pre";
            let block = BLOCK.contains(&tag);
            out.push('['); esc(out, tag); out.push(',');
            let a = attrs.borrow();
            if a.is_empty() { out.push('0'); } else {
                out.push('{');
                for (i, at) in a.iter().enumerate() { if i > 0 { out.push(','); } esc(out, &at.name.local); out.push(':'); esc(out, &at.value); }
                out.push('}');
            }
            for c in h.children.borrow().iter() {
                if !pre && block { if let NodeData::Text { contents } = &c.data { if ws(&contents.borrow()) { continue; } } }
                let mark = out.len(); out.push(',');
                if !walk(out, c, pre) { out.truncate(mark); }
            }
            out.push(']'); true
        }
        _ => false,
    }
}
fn ast(out: &mut String, doc: &ammonia::Document) {
    let root = doc.to_dom_node(); // <html> element of the fragment
    out.push('[');
    let mut first = true;
    for c in root.children.borrow().iter() {
        if let NodeData::Text { contents } = &c.data { if ws(&contents.borrow()) { continue; } }
        let mark = out.len(); if !first { out.push(','); }
        if walk(out, c, false) { first = false; } else { out.truncate(mark); }
    }
    out.push(']');
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let o = comrak_opts(); let b = builder();
    let docs: Vec<String> = serde_json::from_str(&std::fs::read_to_string(&a[2]).unwrap()).unwrap();
    match a[1].as_str() {
        "asts" => {
            let mut out = String::from("[");
            for (i, d) in docs.iter().enumerate() { if i > 0 { out.push(','); } ast(&mut out, &b.clean(&comrak::markdown_to_html(d, &o))); }
            out.push(']'); println!("{out}");
        }
        "time" => {
            let reps: usize = a.get(3).map(|s| s.parse().unwrap()).unwrap_or(15);
            let (mut tot, mut tc, mut ta, mut tw) = (vec![], vec![], vec![], vec![]);
            let mut bytes = 0;
            for _ in 0..reps {
                let (mut c, mut s, mut w) = (0f64, 0f64, 0f64);
                let t0 = Instant::now();
                let mut out = String::with_capacity(1 << 16); out.push('[');
                for (i, d) in docs.iter().enumerate() {
                    let t = Instant::now(); let h = comrak::markdown_to_html(d, &o); let t1 = Instant::now();
                    let doc = b.clean(&h); let t2 = Instant::now();
                    if i > 0 { out.push(','); } out.push_str("{\"id\":1234567890,\"author\":\"someone\",\"created_at\":\"2026-10-24T12:00:00Z\",\"body\":");
                    ast(&mut out, &doc); out.push('}');
                    c += (t1 - t).as_secs_f64(); s += (t2 - t1).as_secs_f64(); w += t2.elapsed().as_secs_f64();
                }
                out.push(']');
                tot.push(t0.elapsed().as_secs_f64() * 1e3); tc.push(c * 1e3); ta.push(s * 1e3); tw.push(w * 1e3);
                bytes = std::hint::black_box(out).len();
            }
            let med = |v: &mut Vec<f64>| { v.sort_by(|x, y| x.partial_cmp(y).unwrap()); v[v.len() / 2] };
            let min = tot.iter().cloned().fold(f64::MAX, f64::min);
            println!("{{\"n\":{},\"total_med\":{:.3},\"total_min\":{:.3},\"comrak\":{:.3},\"ammonia\":{:.3},\"ast\":{:.3},\"bytes\":{}}}", docs.len(), med(&mut tot), min, med(&mut tc), med(&mut ta), med(&mut tw), bytes);
        }
        _ => {}
    }
}
