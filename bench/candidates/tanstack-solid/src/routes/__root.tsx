/// <reference types="vite/client" />
import { HeadContent, Outlet, Scripts, createRootRouteWithContext } from '@tanstack/solid-router'
import { HydrationScript } from 'solid-js/web'
import type { JSX } from 'solid-js'
import type { QueryClient } from '@tanstack/solid-query'
import appCss from '~/app.css?url'

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [{ charset: 'utf-8' }, { name: 'viewport', content: 'width=device-width, initial-scale=1' }, { title: 'beghu · TanStack Start + Solid' }],
    links: [{ rel: 'stylesheet', href: appCss }],
  }),
  component: () => (
    <RootDocument>
      <Outlet />
    </RootDocument>
  ),
})

// Follows the system theme; the light/dark switch is the real app's job.
const themeScript = `document.documentElement.classList.toggle('dark', matchMedia('(prefers-color-scheme: dark)').matches)`

function RootDocument(props: { children: JSX.Element }) {
  return (
    <html lang="en">
      <head>
        <script innerHTML={themeScript} />
        <HydrationScript />
        <HeadContent />
      </head>
      <body class="h-screen overflow-hidden bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
        {props.children}
        <Scripts />
      </body>
    </html>
  )
}
