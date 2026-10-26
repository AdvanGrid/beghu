import { render } from "@solidjs/web";
import { Router } from "./router";
import { Root } from "./Root";
// The one stylesheet besides StyleX's own: rules StyleX can't express.
import "./escape.css";

render(() => <Router>{(props) => <Root>{props.children}</Root>}</Router>, document.getElementById("root")!);
