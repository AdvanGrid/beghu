import type { ComponentView } from 'solid-yield';
import { App } from './App';
// A root that fails with nothing: a project rule written as one line of types.
type Fails<V> = V extends ComponentView<any, infer E, any, any> ? E : never;
export const rootFailsWithNothing: [Fails<ReturnType<typeof App>>] extends [never] ? true : false = true;
