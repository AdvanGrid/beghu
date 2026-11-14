// `/pricing`: free while beghu is in beta.
import * as stylex from "@stylexjs/stylex";
import { colors } from "../src/tokens.stylex";
import { page } from "./Layout";

export function Pricing() {
  return (
    <section {...stylex.attrs(page.prose)}>
      <h1 {...stylex.attrs(page.h1)}>Pricing</h1>
      <p {...stylex.attrs(page.lead)}>beghu is free while it's in beta.</p>
      <div {...stylex.attrs(s.plan)}>
        <h2 {...stylex.attrs(page.h3)}>Beta</h2>
        <p {...stylex.attrs(s.price)}>Free</p>
        <ul {...stylex.attrs(s.list)}>
          <li>Every feature, for every account</li>
          <li>Public and private repos</li>
          <li>Several GitHub accounts in one browser</li>
        </ul>
        <a href="/auth/login" {...stylex.attrs(page.button)}>
          Sign in with GitHub
        </a>
      </div>
      <h2 {...stylex.attrs(page.h2)}>After the beta</h2>
      <p>
        Paid plans will come once we know what running beghu costs. We'll announce them well
        ahead of time, and nothing you use will start costing money without you choosing a plan.
      </p>
    </section>
  );
}

const s = stylex.create({
  plan: {
    padding: 24,
    borderColor: colors.line,
    borderRadius: 10,
    borderStyle: "solid",
    borderWidth: 1,
    backgroundColor: colors.bgRaised,
    marginTop: 32,
  },
  price: {
    marginBlock: 0,
    fontSize: 32,
    fontWeight: 700,
  },
  list: {
    color: colors.muted,
    marginBottom: 24,
    marginTop: 12,
    paddingLeft: 20,
  },
});
