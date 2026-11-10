import { render } from "@solidjs/web";
import { Router } from "./router";
import { Root } from "./Root";
// The one stylesheet besides StyleX's own: rules StyleX can't express.
import "./escape.css";
import { OBSERVE } from "solid-js";
import { attribution } from "solid-js/attribution";

// DEBUG (temporary): report every transition hold and interaction, with what held it.
{
  const safe = (v: unknown) => {
    const seen = new WeakSet();
    return JSON.stringify(v, (_k, x) => {
      if (typeof x === "object" && x !== null) {
        if (seen.has(x)) return "[cycle]";
        seen.add(x);
      }
      if (typeof x === "function") return `[fn ${x.name}]`;
      if (x instanceof Node) return `[node ${x.nodeName}]`;
      return x;
    });
  };
  attribution.enable({ log: false, historyLimit: 5000 });
  (window as unknown as { __attr: unknown }).__attr = attribution;
  for (const t of ["hold", "interaction", "navigation"] as const) {
    OBSERVE?.records.subscribe(t, (e: unknown) => console.log(`[attr ${t}] ${performance.now().toFixed(0)} ${safe(e).slice(0, 3000)}`));
  }
}

render(() => <Router>{(props) => <Root>{props.children}</Root>}</Router>, document.getElementById("root")!);
