"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fastify_plugin_1 = __importDefault(require("fastify-plugin"));
const from_1 = __importDefault(require("./from"));
const ws_1 = __importDefault(require("ws"));
const httpMethods = [
    "DELETE",
    "GET",
    "HEAD",
    "PATCH",
    "POST",
    "PUT",
    "OPTIONS",
];
const urlPattern = /^https?:\/\//;
function convertUrlToWebSocket(urlString) {
    return urlString.replace(/^(http)(s)?:\/\//, "ws$2://");
}
function liftErrorCode(code) {
    if (typeof code !== "number") {
        // Sometimes "close" event emits with a non-numeric value
        return 1011;
    }
    else if (code === 1004 || code === 1005 || code === 1006) {
        // ws module forbid those error codes usage, lift to "application level" (4xxx)
        return 4000 + (code % 1000);
    }
    else {
        return code;
    }
}
function closeWebSocket(socket, code, reason) {
    if (socket.readyState === ws_1.default.OPEN) {
        socket.close(liftErrorCode(code), reason);
    }
}
function waitConnection(socket, write) {
    if (socket.readyState === ws_1.default.CONNECTING) {
        socket.once("open", write);
    }
    else {
        write();
    }
}
function isExternalUrl(url = "") {
    return urlPattern.test(url);
}
function proxyWebSockets(source, target) {
    function close(code, reason) {
        closeWebSocket(source, code, reason);
        closeWebSocket(target, code, reason);
    }
    source.on("message", (data) => waitConnection(target, () => target.send(data)));
    source.on("ping", (data) => waitConnection(target, () => target.ping(data)));
    source.on("pong", (data) => waitConnection(target, () => target.pong(data)));
    source.on("close", close);
    source.on("error", (error) => close(1011, error.message));
    source.on("unexpected-response", () => close(1011, "unexpected response"));
    // source WebSocket is already connected because it is created by ws server
    target.on("message", (data) => source.send(data));
    target.on("ping", (data) => source.ping(data));
    target.on("pong", (data) => source.pong(data));
    target.on("close", close);
    target.on("error", (error) => close(1011, error.message));
    target.on("unexpected-response", () => close(1011, "unexpected response"));
}
function setupWebSocketProxy(fastify, options, rewritePrefix) {
    const server = new ws_1.default.Server(Object.assign({ server: fastify.server }, options.wsServerOptions));
    fastify.addHook("onClose", (instance, done) => server.close(done));
    // To be able to close the HTTP server,
    // all WebSocket clients need to be disconnected.
    // Fastify is missing a pre-close event, or the ability to
    // add a hook before the server.close call. We need to resort
    // to monkeypatching for now.
    const oldClose = fastify.server.close;
    fastify.server.close = function (done) {
        for (const client of server.clients) {
            client.close();
        }
        oldClose.call(this, done);
    };
    server.on("error", (err) => {
        fastify.log.error(err);
    });
    server.on("connection", (source, request) => {
        if (fastify.prefix && !request.url.startsWith(fastify.prefix)) {
            fastify.log.debug({ url: request.url }, "not matching prefix");
            source.close();
            return;
        }
        let optionsWs = {};
        if (request.headers.cookie) {
            const headers = { cookie: request.headers.cookie };
            optionsWs = Object.assign(Object.assign({}, options.wsClientOptions), { headers });
        }
        else {
            optionsWs = options.wsClientOptions;
        }
        const url = createWebSocketUrl(request);
        const target = new ws_1.default(url, optionsWs);
        fastify.log.debug({ url: url.href }, "proxy websocket");
        proxyWebSockets(source, target);
    });
    function createWebSocketUrl(request) {
        const source = new URL(request.url, "ws://127.0.0.1");
        const target = new URL(source.pathname.replace(fastify.prefix, rewritePrefix), convertUrlToWebSocket(options.upstream));
        target.search = source.search;
        return target;
    }
}
function generateRewritePrefix(prefix, opts) {
    if (!prefix) {
        return "";
    }
    let rewritePrefix = opts.rewritePrefix ||
        (opts.upstream ? new URL(opts.upstream).pathname : "/");
    if (!prefix.endsWith("/") && rewritePrefix.endsWith("/")) {
        rewritePrefix = rewritePrefix.slice(0, -1);
    }
    return rewritePrefix;
}
exports.default = (0, fastify_plugin_1.default)((fastify, opts) => __awaiter(void 0, void 0, void 0, function* () {
    if (!opts.upstream &&
        !(opts.replyOptions && typeof opts.replyOptions.getUpstream === "function")) {
        opts.replyOptions = Object.assign(Object.assign({}, opts.replyOptions), { getUpstream: (req, base) => {
                let pathParts = req.url
                    .replace("/upstream/", "")
                    .split("/");
                const [protocol, host, port] = pathParts;
                const url = req.url.indexOf("http") === 0
                    ? new URL(`${req.url}`)
                    : new URL(`${base}${req.url}`);
                return `${base}${url.pathname.replace(`/upstream/${protocol}/${host}/${port}`, "")}`;
            } });
    }
    const preHandler = opts.preHandler || opts.beforeHandler;
    const rewritePrefix = generateRewritePrefix(fastify.prefix, opts);
    const fromOpts = Object.assign({}, opts);
    fromOpts.base = opts.upstream;
    fromOpts.prefix = undefined;
    const oldRewriteHeaders = (opts.replyOptions || {}).rewriteHeaders;
    const replyOpts = Object.assign({}, opts.replyOptions, {
        rewriteHeaders,
    });
    fromOpts.rewriteHeaders = rewriteHeaders;
    fastify.register(from_1.default, fromOpts);
    function rewriteHeaders(headers) {
        const location = headers.location;
        if (location && !isExternalUrl(location)) {
            headers.location = location.replace(rewritePrefix, fastify.prefix);
        }
        if (oldRewriteHeaders) {
            headers = oldRewriteHeaders(headers);
        }
        return headers;
    }
    function bodyParser(req, payload, done) {
        done(null, payload);
    }
    fastify.route({
        url: "/",
        method: opts.httpMethods || httpMethods,
        preHandler,
        config: opts.config || {},
        constraints: opts.constraints || {},
        handler,
    });
    fastify.route({
        url: "/*",
        method: opts.httpMethods || httpMethods,
        preHandler,
        config: opts.config || {},
        constraints: opts.constraints || {},
        handler,
    });
    function handler(request, reply) {
        const queryParamIndex = request.raw.url.indexOf("?");
        let dest = request.raw.url.slice(0, queryParamIndex !== -1 ? queryParamIndex : undefined);
        dest = dest.replace(this.prefix, rewritePrefix);
        // if no upstream specified, or this path wasn't already handled then return 404
        if (!request.headers.upstream &&
            request.raw.url.indexOf("upstream") === -1) {
            reply.code(404);
        }
        if (request.raw.url.indexOf("upstream") !== -1) {
            // do a quick check to see if upstream is passed in as a path
            // this is so we can proxy RPC requests where query params are not passed along
            let pathParts = request.raw.url
                .replace("/upstream/", "")
                .split("/");
            const [protocol, host, port] = pathParts;
            dest = "/"; // @todo: fix this
            if (protocol && host && port) {
                replyOpts.upstream = `${protocol}://${host}:${port}`;
            }
        }
        reply.from(dest || "/", replyOpts);
    }
    setupWebSocketProxy(fastify, opts, rewritePrefix);
}), {
    fastify: "3.x",
    name: "@dmikey/fastify-mtls-proxy",
});
