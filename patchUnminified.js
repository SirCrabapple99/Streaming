// fetch and xhr monkey patches (should work universally as a drag and drop I think)
(() => {
    // loading bar
    window.snProgress = { loaded: 0, total: "50.62MB" };

    // note that this function has a bug when going from a string to a number and I don't feel like fixing it
    function formatBytes(input) {
        const units = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4, PB: 1024 ** 5 };

        if (typeof input === 'string') {
            const m = input.trim().match(/^([\d.]+)\s*([BKMGTP])?B?$/i);
            if (!m) throw new Error(`bad size: ${input}`);
            const [, num, unit = 'B'] = m;
            return Math.round(parseFloat(num) * units[unit.toUpperCase()]);
        }

        const order = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
        let n = input, i = 0;
        while (n >= 1024 && i < order.length - 1) { n /= 1024; i++; }
        const s = n >= 100 || i === 0 ? n.toFixed(0) : n.toFixed(2);
        return `${s}${order[i]}`;
    }

    const origFetch = window.fetch.bind(window);
    const OrigXHR = window.XMLHttpRequest;
    const origOpen = OrigXHR.prototype.open;
    const origSend = OrigXHR.prototype.send;

    const partExistCache = new Map();
    const partSizesCache = new Map();

    function hasParts(baseUrl) {
        if (!partExistCache.has(baseUrl)) {
            partExistCache.set(baseUrl, (async () => {
                try {
                    const probe = await origFetch(baseUrl + ".part000", { method: "HEAD" });
                    return probe.ok;
                } catch { return false; }
            })());
        }
        return partExistCache.get(baseUrl);
    }

    // returns null if a head fails
    function partSizes(baseUrl) {
        if (!partSizesCache.has(baseUrl)) {
            partSizesCache.set(baseUrl, (async () => {
                const sizes = [];
                for (let i = 0; ; i++) {
                    const partUrl = baseUrl + ".part" + String(i).padStart(3, "0");
                    let res;
                    try { res = await origFetch(partUrl, { method: "HEAD" }); } catch { break; }
                    if (!res.ok) break;
                    const len = parseInt(res.headers.get("Content-Length") || "", 10);
                    if (!Number.isFinite(len)) return null; // can"t compute total
                    sizes.push(len);
                }
                return sizes.length ? sizes : null;
            })());
        }
        return partSizesCache.get(baseUrl);
    }

    // stream generator
    async function* streamParts(baseUrl) {
        for (let i = 0; ; i++) {
            const partUrl = baseUrl + ".part" + String(i).padStart(3, "0");
            let res;
            try { res = await origFetch(partUrl); } catch { return; }
            if (!res.ok) return;
            const reader = res.body.getReader();
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                yield value;
            }
        }
    }

    // make readable stream
    function stitchedStream(baseUrl) {
        const iter = streamParts(baseUrl);
        return new ReadableStream({
            async pull(controller) {
                const { value, done } = await iter.next();
                if (done) controller.close();
                else controller.enqueue(value);
            },
            async cancel(reason) {
                try { await iter.return(reason); } catch { }
            }
        });
    }

    // fetch
    window.fetch = async function (resource, options = {}) {
        const url = typeof resource === "string" ? resource : resource.url;
        const method = (options.method || (resource && resource.method) || "GET").toUpperCase();

        if ((method === "GET" || method === "HEAD") && await hasParts(url)) {
            if (method === "HEAD") {
                const sizes = await partSizes(url);
                const headers = new Headers({ "Content-Type": "application/octet-stream" });
                if (sizes) headers.set("Content-Length", String(sizes.reduce((a, b) => a + b, 0)));
                return new Response(null, { status: 200, statusText: "OK", headers });
            }
            const sizes = await partSizes(url);
            const headers = new Headers({ "Content-Type": "application/octet-stream" });
            if (sizes) headers.set("Content-Length", String(sizes.reduce((a, b) => a + b, 0)));
            return new Response(stitchedStream(url), { status: 200, statusText: "OK", headers });
        }
        return origFetch(resource, options);
    };

    // xhr
    OrigXHR.prototype.open = function (method, url, ...rest) {
        this._snMethod = (method || "GET").toUpperCase();
        this._snUrl = url;
        return origOpen.call(this, method, url, ...rest);
    };

    OrigXHR.prototype.send = function (body) {
        const xhr = this;
        const url = xhr._snUrl;
        const method = xhr._snMethod;
        const sendArgs = arguments;

        if (method !== "GET" && method !== "HEAD") {
            return origSend.apply(xhr, sendArgs);
        }

        hasParts(url).then(async exists => {
            if (!exists) return origSend.apply(xhr, sendArgs);

            const fire = (type, EventCtor, init) => {
                const evt = new EventCtor(type, init);
                xhr.dispatchEvent(evt);
                const h = xhr["on" + type];
                if (typeof h === "function") { try { h.call(xhr, evt); } catch { } }
            };

            // Resolve total up front if possible for accurate progress (doesn't work rn)
            const sizes = await partSizes(url);
            const total = sizes ? sizes.reduce((a, b) => a + b, 0) : 0;
            const lengthComputable = !!sizes;

            if (method === "HEAD") {
                try {
                    Object.defineProperties(xhr, {
                        status: { configurable: true, get: () => 200 },
                        statusText: { configurable: true, get: () => "OK" },
                        readyState: { configurable: true, get: () => 4 },
                        response: { configurable: true, get: () => null },
                    });
                } catch { }
                fire("readystatechange", Event, {});
                fire("load", ProgressEvent, { lengthComputable, loaded: total, total });
                fire("loadend", ProgressEvent, { lengthComputable, loaded: total, total });
                return;
            }

            // Stream parts into a list of chunks and fire progress per chunk
            const chunks = [];
            let loaded = 0;
            let aborted = false;
            const onAbort = () => { aborted = true; };
            xhr.addEventListener("abort", onAbort);

            let lastProgress = 0;
            try {
                for await (const chunk of streamParts(url)) {
                    if (aborted) return;
                    chunks.push(chunk);
                    loaded += chunk.byteLength;
                    const now = performance.now();
                    if (now - lastProgress > 100) {
                        fire("progress", ProgressEvent, { lengthComputable, loaded, total: total || loaded });
                        lastProgress = now;

                        const el = document.getElementById("snMbText");
                        if (el) el.textContent = formatBytes(loaded) + " / " + window.snProgress.total;
                    }
                }

                // final progress event so the bar reaches 100%
                fire("progress", ProgressEvent, { lengthComputable, loaded, total: total || loaded });
                const el = document.getElementById("snMbText");
                if (el) el.textContent = formatBytes(loaded) + " / " + window.snProgress.total;

                const el2 = document.getElementById("snLoadingBG");
                const el3 = document.getElementById("snLoadingTextHolder");

                if (el2) el2.style.visibility = "hidden";
                if (el3) el3.style.visibility = "hidden";

            } catch (e) {
                fire("error", ProgressEvent, { lengthComputable: false, loaded, total: 0 });
                fire("loadend", ProgressEvent, { lengthComputable: false, loaded, total: 0 });
                return;
            } finally {
                xhr.removeEventListener("abort", onAbort);
            }

            // Assemble final response value based on responsetype
            const finalTotal = loaded;
            const assemble = () => {
                const merged = new Uint8Array(finalTotal);
                let off = 0;
                for (const c of chunks) { merged.set(c, off); off += c.byteLength; }
                return merged;
            };

            const rt = xhr.responseType;
            let responseValue;
            let responseTextGetter = null;
            if (rt === "arraybuffer") {
                responseValue = assemble().buffer;
            } else if (rt === "blob") {
                responseValue = new Blob(chunks);
            } else if (rt === "json") {
                try { responseValue = JSON.parse(new TextDecoder().decode(assemble())); }
                catch { responseValue = null; }
            } else {
                // "" or "text"
                const text = new TextDecoder().decode(assemble());
                responseValue = text;
                responseTextGetter = () => text;
            }

            try {
                const defs = {
                    status: { configurable: true, get: () => 200 },
                    statusText: { configurable: true, get: () => "OK" },
                    readyState: { configurable: true, get: () => 4 },
                    response: { configurable: true, get: () => responseValue },
                };
                if (responseTextGetter) {
                    defs.responseText = { configurable: true, get: responseTextGetter };
                }
                Object.defineProperties(xhr, defs);
            } catch { }

            window.snProgress.loaded = loaded;

            // fake the load thing so client doesn't read a 404
            fire("readystatechange", Event, {});
            fire("load", ProgressEvent, { lengthComputable, loaded: finalTotal, total: total || finalTotal });
            fire("loadend", ProgressEvent, { lengthComputable, loaded: finalTotal, total: total || finalTotal });
        });
    };
})();