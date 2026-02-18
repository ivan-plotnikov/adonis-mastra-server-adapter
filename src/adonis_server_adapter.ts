import type { HttpContext } from '@adonisjs/core/http'
import type { HttpRouterService } from '@adonisjs/core/types'
import type { ToolsInput } from '@mastra/core/agent'
import type { Mastra } from '@mastra/core/mastra'
import type { ApiRoute } from '@mastra/core/server'
import { RequestContext } from '@mastra/core/request-context'
import { formatZodError } from '@mastra/server/handlers/error'
import {
    MastraServer,
    normalizeQueryParams,
    redactStreamChunk,
    type BodyLimitOptions,
    type MCPOptions,
    type ParsedRequestParams,
    type ServerRoute,
    type StreamOptions,
} from '@mastra/server/server-adapter'
import type { InMemoryTaskStore } from '@mastra/server/a2a/store'
import { ZodError } from 'zod'

interface AdonisMastraServerOptions {
    app: HttpRouterService
    mastra: Mastra
    prefix?: string
    openapiPath?: string
    bodyLimitOptions?: BodyLimitOptions
    streamOptions?: StreamOptions
    tools?: ToolsInput
    taskStore?: InMemoryTaskStore
    customRouteAuthConfig?: Map<string, boolean>
    customApiRoutes?: ApiRoute[]
    mcpOptions?: MCPOptions
}

interface RegisterAdonisMastraServerOptions extends Omit<AdonisMastraServerOptions, 'app'> {
    router: HttpRouterService
}

interface NodeResponseLike {
    writableEnded?: boolean
    on(event: 'close', listener: () => void): void
    write(chunk: unknown): void
    end(chunk?: string): void
    writeHead(status: number, headers: Record<string, string | string[]>): void
    setHeader?(name: string, value: string): void
}

const REQUEST_METHODS_WITH_BODY = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

type MastraMiddlewareHandler = (
    context: {
        req: {
            method: string
            path: string
            query: (key: string) => string | undefined
            header: (name: string) => string | undefined
        }
        header: (name: string, value: string) => void
        set: (key: string, value: unknown) => void
        get: (key: string) => unknown
    },
    next: () => Promise<void>
) => Promise<Response | void>

type NormalizedMastraMiddleware = {
    path: string
    handler: MastraMiddlewareHandler
}

export class AdonisMastraServer extends MastraServer<HttpRouterService, HttpContext, HttpContext> {
    private contextMiddlewares: NormalizedMastraMiddleware[] = []

    private shouldCheckRouteAuth = false

    registerContextMiddleware(): void {
        this.contextMiddlewares = this.normalizeServerMiddlewares()
    }

    registerAuthMiddleware(): void {
        this.shouldCheckRouteAuth = Boolean(this.mastra.getServer()?.auth)
    }

    async registerCustomApiRoutes(): Promise<void> {
        const hasCustomRoutes = await this.buildCustomRouteHandler()
        if (!hasCustomRoutes) {
            return
        }

        const customRoutes = this.customApiRoutes ?? this.mastra.getServer()?.apiRoutes ?? []
        for (const route of customRoutes) {
            const routePath = this.buildRoutePath(this.prefix, route.path)
            this.registerAdonisHandler(
                this.app,
                route.method,
                routePath,
                this.withMastraPipeline(
                    {
                        requiresAuth: route.requiresAuth,
                    },
                    async (ctx, runtime) => {
                        const body = REQUEST_METHODS_WITH_BODY.has(route.method)
                            ? ctx.request.body()
                            : undefined
                        const response = await this.handleCustomRouteRequest(
                            this.buildAbsoluteRequestUrl(ctx),
                            route.method,
                            ctx.request.headers(),
                            body,
                            runtime.requestContext
                        )

                        if (!response) {
                            ctx.response.status(404)
                            ctx.response.json({ error: 'Custom route not found' })
                            return
                        }

                        await this.writeCustomRouteResponse(response, ctx.response.response)
                    }
                )
            )
        }
    }

    async registerRoute(
        app: HttpRouterService,
        route: ServerRoute,
        { prefix }: { prefix?: string }
    ): Promise<void> {
        const resolvedPrefix = prefix ?? this.prefix
        const fullPath = this.buildRoutePath(resolvedPrefix, route.path)

        this.registerAdonisHandler(
            app,
            route.method,
            fullPath,
            this.withMastraPipeline(
                {
                    requiresAuth: (route as { requiresAuth?: boolean }).requiresAuth,
                },
                async (ctx, runtime) => {
                    const maxSize = route.maxBodySize ?? this.bodyLimitOptions?.maxSize
                    if (REQUEST_METHODS_WITH_BODY.has(route.method) && maxSize) {
                        const contentLength = ctx.request.header('content-length')
                        const parsedLength = contentLength
                            ? Number.parseInt(contentLength, 10)
                            : Number.NaN

                        if (Number.isFinite(parsedLength) && parsedLength > maxSize) {
                            const payload = this.bodyLimitOptions?.onError
                                ? this.bodyLimitOptions.onError({ error: 'Request body too large' })
                                : { error: 'Request body too large' }

                            ctx.response.status(413)
                            ctx.response.json(payload)
                            return
                        }
                    }

                    const params = await this.getParams(route, ctx)
                    if (params.bodyParseError) {
                        ctx.response.status(400)
                        ctx.response.json({
                            error: 'Invalid request body',
                            issues: [{ field: 'body', message: params.bodyParseError.message }],
                        })
                        return
                    }

                    const pathParams = await this.parsePath(route, params.urlParams, ctx)
                    if (!pathParams) {
                        return
                    }

                    const queryParams = await this.parseQuery(route, params.queryParams, ctx)
                    if (!queryParams) {
                        return
                    }

                    const body = await this.parseRequestBody(route, params.body, ctx)
                    if (body === null) {
                        return
                    }

                    const handlerParams = {
                        ...pathParams,
                        ...queryParams,
                        ...(typeof body === 'object' && true ? body : {}),
                        mastra: this.mastra,
                        requestContext: runtime.requestContext,
                        registeredTools: runtime.registeredTools,
                        taskStore: runtime.taskStore,
                        abortSignal: runtime.abortSignal,
                        routePrefix: resolvedPrefix,
                    }

                    try {
                        const result = await route.handler(handlerParams)
                        await this.sendResponse(route, ctx, result)
                    } catch (error) {
                        this.mastra.getLogger()?.error('Error calling Mastra route handler', {
                            error:
                                error instanceof Error
                                    ? { message: error.message, stack: error.stack }
                                    : error,
                            path: route.path,
                            method: route.method,
                        })

                        const status = this.resolveErrorStatus(error)
                        ctx.response.status(status)
                        ctx.response.json({
                            error: error instanceof Error ? error.message : 'Unknown error',
                        })
                    }
                }
            )
        )
    }

    async getParams(route: ServerRoute, request: HttpContext): Promise<ParsedRequestParams> {
        const queryParams = normalizeQueryParams(request.request.qs())
        const urlParams = Object.entries(request.params).reduce<Record<string, string>>(
            (acc, [key, value]) => {
                acc[key] = String(value)
                return acc
            },
            {}
        )

        const body = REQUEST_METHODS_WITH_BODY.has(route.method)
            ? request.request.body()
            : undefined

        return {
            urlParams,
            queryParams,
            body,
        }
    }

    async sendResponse(
        route: ServerRoute,
        response: HttpContext,
        result: unknown
    ): Promise<unknown> {
        const resolvedPrefix = this.prefix ?? ''

        if (route.responseType === 'json') {
            response.response.json(result)
            return
        }

        if (route.responseType === 'stream') {
            await this.stream(route, response, result)
            return
        }

        if (route.responseType === 'datastream-response') {
            const fetchResponse = result as Response
            fetchResponse.headers.forEach((value, key) => {
                response.response.header(key, value)
            })
            response.response.status(fetchResponse.status)

            if (fetchResponse.body) {
                const reader = fetchResponse.body.getReader()
                const rawResponse = response.response.response
                try {
                    while (true) {
                        const { done, value } = await reader.read()
                        if (done) {
                            break
                        }
                        rawResponse.write(value)
                    }
                } finally {
                    rawResponse.end()
                }
            } else {
                response.response.response.end()
            }

            return
        }

        if (route.responseType === 'mcp-http') {
            const payload = result as {
                server: {
                    startHTTP: (options: {
                        url: URL
                        httpPath: string
                        req: unknown
                        res: unknown
                        options?: MCPOptions
                    }) => Promise<void>
                }
                httpPath: string
                mcpOptions?: MCPOptions
            }

            const options = { ...this.mcpOptions, ...payload.mcpOptions }

            try {
                await payload.server.startHTTP({
                    url: new URL(this.buildAbsoluteRequestUrl(response)),
                    httpPath: this.buildRoutePath(resolvedPrefix, payload.httpPath),
                    req: response.request.request,
                    res: response.response.response,
                    options: Object.keys(options).length > 0 ? options : undefined,
                })
            } catch {
                if (!response.response.headersSent) {
                    response.response.status(500)
                    response.response.json({
                        jsonrpc: '2.0',
                        error: { code: -32603, message: 'Internal server error' },
                        id: null,
                    })
                }
            }

            return
        }

        if (route.responseType === 'mcp-sse') {
            const payload = result as {
                server: {
                    startSSE: (options: {
                        url: URL
                        ssePath: string
                        messagePath: string
                        req: unknown
                        res: unknown
                    }) => Promise<void>
                }
                ssePath: string
                messagePath: string
            }

            try {
                await payload.server.startSSE({
                    url: new URL(this.buildAbsoluteRequestUrl(response)),
                    ssePath: this.buildRoutePath(resolvedPrefix, payload.ssePath),
                    messagePath: this.buildRoutePath(resolvedPrefix, payload.messagePath),
                    req: response.request.request,
                    res: response.response.response,
                })
            } catch {
                if (!response.response.headersSent) {
                    response.response.status(500)
                    response.response.json({ error: 'Error handling MCP SSE request' })
                }
            }

            return
        }

        response.response.status(500)
        response.response.json({ error: 'Unsupported response type' })
    }

    async stream(route: ServerRoute, response: HttpContext, result: unknown): Promise<unknown> {
        const streamFormat = route.streamFormat ?? 'stream'
        const isSse = streamFormat === 'sse'

        response.response.header('Content-Type', isSse ? 'text/event-stream' : 'text/plain')
        response.response.header('Transfer-Encoding', 'chunked')
        response.response.header('Cache-Control', 'no-cache')

        const rawResponse = response.response.response
        const readableStream =
            result instanceof ReadableStream
                ? result
                : ((result as { fullStream?: ReadableStream }).fullStream ?? null)

        if (!readableStream) {
            rawResponse.end()
            return
        }

        const reader = readableStream.getReader()

        try {
            while (true) {
                const { done, value } = await reader.read()
                if (done) {
                    break
                }

                if (!value) {
                    continue
                }

                const shouldRedact = this.streamOptions?.redact ?? true
                const outputValue = shouldRedact ? redactStreamChunk(value) : value

                if (isSse) {
                    rawResponse.write(`data: ${JSON.stringify(outputValue)}\n\n`)
                } else {
                    rawResponse.write(JSON.stringify(outputValue) + '\x1E')
                }
            }
        } catch (error) {
            this.mastra.getLogger()?.error('Error in Mastra stream processing', {
                error:
                    error instanceof Error ? { message: error.message, stack: error.stack } : error,
            })
        } finally {
            rawResponse.end()
        }
    }

    private withMastraPipeline(
        route: { requiresAuth?: boolean },
        handler: (
            ctx: HttpContext,
            runtime: ReturnType<AdonisMastraServer['createRuntimeContext']>
        ) => Promise<void>
    ) {
        return async (ctx: HttpContext) => {
            const runtime = this.createRuntimeContext(ctx)

            const middlewareResponse = await this.runContextMiddlewares(ctx, runtime.requestContext)
            if (middlewareResponse) {
                await this.writeFetchResponse(ctx, middlewareResponse)
                return
            }

            if (this.shouldCheckRouteAuth) {
                const authFailure = await this.checkRouteAuth(
                    { requiresAuth: route.requiresAuth } as ServerRoute,
                    {
                        path: ctx.request.url(),
                        method: ctx.request.method(),
                        getHeader: (name) => ctx.request.header(name) ?? undefined,
                        getQuery: (name) => {
                            const value = ctx.request.qs()[name]
                            if (typeof value === 'string') {
                                return value
                            }
                            if (Array.isArray(value) && typeof value[0] === 'string') {
                                return value[0]
                            }
                            return undefined
                        },
                        requestContext: runtime.requestContext,
                    }
                )

                if (authFailure) {
                    ctx.response.status(authFailure.status)
                    ctx.response.json({ error: authFailure.error })
                    return
                }
            }

            await handler(ctx, runtime)
        }
    }

    private normalizeServerMiddlewares(): NormalizedMastraMiddleware[] {
        const configured = this.mastra.getServer()?.middleware
        if (!configured) {
            return []
        }

        const list = Array.isArray(configured) ? configured : [configured]
        return list.map((entry) => {
            if (typeof entry === 'function') {
                return {
                    path: this.remapApiPathToPrefix('/api/*'),
                    handler: entry as MastraMiddlewareHandler,
                }
            }

            return {
                path: this.remapApiPathToPrefix(entry.path || '/api/*'),
                handler: entry.handler as MastraMiddlewareHandler,
            }
        })
    }

    private remapApiPathToPrefix(path: string): string {
        const prefix = this.prefix || '/api'
        if (!path.startsWith('/api')) {
            return path
        }

        if (prefix === '/api') {
            return path
        }

        return `${prefix}${path.slice('/api'.length)}`
    }

    private async runContextMiddlewares(
        ctx: HttpContext,
        requestContext: RequestContext
    ): Promise<Response | null> {
        const pathname = ctx.request.url()
        const matched = this.contextMiddlewares.filter((middleware) =>
            this.matchesMiddlewarePath(middleware.path, pathname)
        )

        if (matched.length === 0) {
            return null
        }

        const state = new Map<string, unknown>()
        state.set('mastra', this.mastra)
        state.set('requestContext', requestContext)
        if (this.customRouteAuthConfig) {
            state.set('customRouteAuthConfig', this.customRouteAuthConfig)
        }

        const context = {
            req: {
                method: ctx.request.method(),
                path: pathname,
                query: (key: string) => {
                    const value = ctx.request.qs()[key]
                    if (typeof value === 'string') {
                        return value
                    }
                    if (Array.isArray(value) && typeof value[0] === 'string') {
                        return value[0]
                    }
                    return undefined
                },
                header: (name: string) => ctx.request.header(name) ?? undefined,
            },
            header: (name: string, value: string) => {
                ctx.response.header(name, value)
                const rawResponse = ctx.response.response as NodeResponseLike
                rawResponse.setHeader?.(name, value)
            },
            set: (key: string, value: unknown) => {
                state.set(key, value)
            },
            get: (key: string) => state.get(key),
        }

        const dispatch = async (index: number): Promise<Response | void> => {
            const middleware = matched[index]
            if (!middleware) {
                return
            }

            return middleware.handler(context, async () => {
                await dispatch(index + 1)
            })
        }

        const result = await dispatch(0)
        return result instanceof Response ? result : null
    }

    private matchesMiddlewarePath(pattern: string, pathname: string): boolean {
        if (pattern === '*' || pattern === '/*') {
            return true
        }

        if (pattern.endsWith('/*')) {
            const prefix = pattern.slice(0, -1)
            return pathname.startsWith(prefix)
        }

        if (pattern.endsWith('*')) {
            const prefix = pattern.slice(0, -1)
            return pathname.startsWith(prefix)
        }

        return pathname === pattern
    }

    private async writeFetchResponse(ctx: HttpContext, response: Response): Promise<void> {
        response.headers.forEach((value, key) => {
            ctx.response.header(key, value)
        })
        ctx.response.status(response.status)

        if (response.body) {
            const reader = response.body.getReader()
            const rawResponse = ctx.response.response

            try {
                while (true) {
                    const { done, value } = await reader.read()
                    if (done) {
                        break
                    }

                    rawResponse.write(value)
                }
            } finally {
                rawResponse.end()
            }

            return
        }

        ctx.response.send(await response.text())
    }

    private registerAdonisHandler(
        app: HttpRouterService,
        method: ServerRoute['method'] | ApiRoute['method'],
        path: string,
        handler: (ctx: HttpContext) => Promise<void>
    ) {
        switch (method) {
            case 'GET':
                app.get(path, handler)
                break
            case 'POST':
                app.post(path, handler)
                break
            case 'PUT':
                app.put(path, handler)
                break
            case 'PATCH':
                app.patch(path, handler)
                break
            case 'DELETE':
                app.delete(path, handler)
                break
            case 'ALL':
            default:
                app.any(path, handler)
                break
        }
    }

    private createRuntimeContext(ctx: HttpContext) {
        const requestContext = this.extractRequestContext(ctx)

        const abortController = new AbortController()
        const rawResponse = ctx.response.response as NodeResponseLike

        rawResponse.on('close', () => {
            if (!rawResponse.writableEnded) {
                abortController.abort()
            }
        })

        return {
            requestContext,
            abortSignal: abortController.signal,
            registeredTools: this.tools ?? {},
            taskStore: this.taskStore,
        }
    }

    private extractRequestContext(ctx: HttpContext): RequestContext {
        const body = ctx.request.body()
        const rawQueryRequestContext = ctx.request.qs().requestContext

        const paramsRequestContext = this.tryParseRequestContext(rawQueryRequestContext)
        const bodyRequestContext =
            body && typeof body === 'object' && !Array.isArray(body)
                ? this.tryParseRequestContext((body as Record<string, unknown>).requestContext)
                : undefined

        return this.mergeRequestContext({ paramsRequestContext, bodyRequestContext })
    }

    private tryParseRequestContext(value: unknown): Record<string, any> | undefined {
        if (!value) {
            return undefined
        }

        if (typeof value === 'object' && !Array.isArray(value)) {
            return value as Record<string, any>
        }

        const candidate = Array.isArray(value) ? value[0] : value
        if (typeof candidate !== 'string') {
            return undefined
        }

        try {
            return JSON.parse(candidate) as Record<string, any>
        } catch {
            try {
                const decoded = Buffer.from(candidate, 'base64').toString('utf-8')
                return JSON.parse(decoded) as Record<string, any>
            } catch {
                return undefined
            }
        }
    }

    private buildRoutePath(prefix: string | undefined, path: string) {
        const normalizedPrefix = (prefix ?? '').replace(/\/+$/, '')
        const normalizedPath = path.startsWith('/') ? path : `/${path}`

        if (!normalizedPrefix) {
            return normalizedPath
        }

        return `${normalizedPrefix}${normalizedPath}`
    }

    private buildAbsoluteRequestUrl(ctx: HttpContext) {
        const protocol = ctx.request.protocol()
        const host = ctx.request.header('host') || 'localhost'
        const relativeUrl = ctx.request.url(true)
        return new URL(relativeUrl, `${protocol}://${host}`).toString()
    }

    private async parsePath(
        route: ServerRoute,
        params: Record<string, string>,
        ctx: HttpContext
    ): Promise<Record<string, any> | null> {
        try {
            return await this.parsePathParams(route, params)
        } catch (error) {
            this.handleParseError(error, 'path parameters', ctx)
            return null
        }
    }

    private async parseQuery(
        route: ServerRoute,
        params: ParsedRequestParams['queryParams'],
        ctx: HttpContext
    ): Promise<Record<string, any> | null> {
        try {
            return await this.parseQueryParams(route, params)
        } catch (error) {
            this.handleParseError(error, 'query parameters', ctx)
            return null
        }
    }

    private async parseRequestBody(
        route: ServerRoute,
        body: unknown,
        ctx: HttpContext
    ): Promise<unknown | null> {
        try {
            return await this.parseBody(route, body)
        } catch (error) {
            this.handleParseError(error, 'request body', ctx)
            return null
        }
    }

    private handleParseError(error: unknown, target: string, ctx: HttpContext) {
        this.mastra.getLogger()?.error(`Error parsing ${target}`, {
            error: error instanceof Error ? { message: error.message, stack: error.stack } : error,
        })

        if (error instanceof ZodError) {
            ctx.response.status(400)
            ctx.response.json(formatZodError(error, target))
            return
        }

        ctx.response.status(400)
        ctx.response.json({
            error: `Invalid ${target}`,
            issues: [
                {
                    field: 'unknown',
                    message: error instanceof Error ? error.message : 'Unknown error',
                },
            ],
        })
    }

    private resolveErrorStatus(error: unknown) {
        if (error && typeof error === 'object') {
            if ('status' in error && typeof error.status === 'number') {
                return error.status
            }

            if (
                'details' in error &&
                error.details &&
                typeof error.details === 'object' &&
                'status' in error.details &&
                typeof error.details.status === 'number'
            ) {
                return error.details.status
            }
        }

        return 500
    }
}

export async function registerAdonisMastraServer({
    router,
    mastra,
    prefix,
    openapiPath,
    bodyLimitOptions,
    streamOptions,
    tools,
    taskStore,
    customRouteAuthConfig,
    customApiRoutes,
    mcpOptions,
}: RegisterAdonisMastraServerOptions) {
    const server = new AdonisMastraServer({
        app: router,
        mastra,
        prefix,
        openapiPath,
        bodyLimitOptions,
        streamOptions,
        tools,
        taskStore,
        customRouteAuthConfig,
        customApiRoutes,
        mcpOptions,
    })

    await server.init()
    return server
}
