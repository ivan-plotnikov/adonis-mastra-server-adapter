# @pltn/adonis-mastra-server-adapter

AdonisJS adapter for Mastra server routes.

## Installation

```bash
npm i @pltn/adonis-mastra-server-adapter
```

Peer dependencies (install in your app):

```bash
npm i @adonisjs/core @mastra/core @mastra/server zod
```

## Usage

```ts
import router from '@adonisjs/core/services/router'
import { mastra } from './mastra/index.js'
import { registerAdonisMastraServer } from '@pltn/adonis-mastra-server-adapter'

await registerAdonisMastraServer({
  router,
  mastra,
  prefix: '/mastra',
})
```

## Auth behavior

- Uses Adonis session (`ctx.auth.check()`) for protected routes.
- If route has `requiresAuth !== false` and no session user is present, returns `401`.

## Local development

```bash
npm install
npm run typecheck
npm run build
```

## Publish

```bash
npm publish --access public
```

Before publishing, change package name/scope if needed.
