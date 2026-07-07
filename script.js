// this is some old code I just remade this with new ui

// background animation stuff
const background = document.getElementById("background");
let lastX = 0;
let lastY = 0;
let isTracking = true;

window.addEventListener("mousemove", (e) => {
    if (!isTracking) {
        lastX = e.clientX;
        lastY = e.clientY;
        isTracking = true;
        return;
    }
    let bgX = parseFloat(background.style.backgroundPositionX) || 0;
    let bgY = parseFloat(background.style.backgroundPositionY) || 0;
    background.style.backgroundPositionX = bgX + (e.clientX - lastX) / 150 + "px";
    background.style.backgroundPositionY = bgY + (e.clientY - lastY) / 150 + "px";
    lastX = e.clientX;
    lastY = e.clientY;
});

document.addEventListener("mouseout", (e) => {
    if (!e.relatedTarget) isTracking = false;
});

function formatBytes(input) {
    const units = { B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4, P: 1024 ** 5 };

    if (typeof input === 'string') {
        const m = input.trim().match(/^([\d.]+)\s*([BKMGTP])?B?$/i);
        if (!m) throw new Error(`bad size: ${input}`);
        const [, num, unit = 'B'] = m;
        return Math.round(parseFloat(num) * units[unit.toUpperCase()]);
    }

    const order = ['B', 'K', 'M', 'G', 'T', 'P'];
    let n = input, i = 0;
    while (n >= 1024 && i < order.length - 1) { n /= 1024; i++; }
    const s = n >= 100 || i === 0 ? n.toFixed(0) : n.toFixed(2);
    return `${s}${order[i]}`;
}

// output stuff
let fileTree = {

}

// splitting
function splitFile(file, chunkSize) {
    const chunks = [];
    for (let offset = 0; offset < file.size; offset += chunkSize) {
        chunks.push(file.slice(offset, offset + chunkSize));
    }
    return chunks;
}

// file processing
const maxSize = formatBytes("20M");
const chunkSize = formatBytes("15M");
function checkLargeFiles(entries) {
    // entries: iterable of {path, blob}
    // do file splitting or leave the same if not bigger than maxSize
    for (const { path, blob } of entries) {
        const parts = path.split("/");
        let node = fileTree;

        console.log(path, blob.size, blob.size > maxSize ? 'SPLIT' : 'keep');

        for (let i = 0; i < parts.length - 1; i++) {
            node[parts[i]] ??= {};
            node = node[parts[i]];
        }

        const name = parts.at(-1);
        if (blob.size > maxSize) {
            const chunks = splitFile(blob, chunkSize);
            chunks.forEach((chunk, i) => {
                node[`${name}.part${String(i).padStart(3, '0')}`] = chunk;
            });
        } else {
            node[name] = blob;
        }
    }
}

// upload events
function uploadFolder() {
    const uploadButton = document.getElementById("uploadFolder");
    uploadButton.click();
}

function uploadArchive() {
    const uploadButton = document.getElementById("uploadArchive");
    uploadButton.click();
}

document.getElementById('uploadFolder').addEventListener('change', (e) => {
    fileTree = {};
    checkLargeFiles(Array.from(e.target.files, (file) => ({ path: file.webkitRelativePath, blob: file })));
});

document.getElementById('uploadArchive').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const data = new Uint8Array(await file.arrayBuffer());
    const unzipped = fflate.unzipSync(data);

    fileTree = {};
    checkLargeFiles(
        Object.entries(unzipped)
            .filter(([path]) => !path.endsWith('/'))
            .map(([path, bytes]) => ({ path, blob: new Blob([bytes]) }))
    );
});

// download stuff
async function downloadFolder() {
    if (Object.keys(fileTree).length === 0) {
        alert("no files loaded!");
        return;
    }

    const found = await findHTML();
    if (!found) {
        alert("no html found!");
        return;
    }
    const htmlPath = found.path;
    const finalHtml = await inlinePreset(found.html);

    let dirHandle;
    try {
        dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
    } catch {
        console.log("user closed file picker");
        return;
    }

    // walk walk walk walk walk walk walk walk
    async function downloadWalk(dir, handle, path = '') {
        for (const [key, value] of Object.entries(dir)) {
            const currentPath = path ? `${path}/${key}` : key;
            if (value instanceof Blob) {
                const fileHandle = await handle.getFileHandle(key, { create: true });
                const writable = await fileHandle.createWritable();
                if (currentPath === htmlPath) {
                    await writable.write(finalHtml);
                } else {
                    await writable.write(value);
                }
                await writable.close();
            } else {
                await downloadWalk(
                    value,
                    await handle.getDirectoryHandle(key, { create: true }),
                    currentPath
                );
            }
        }
    }

    await downloadWalk(fileTree, dirHandle);
}

async function downloadArchive() {
    if (Object.keys(fileTree).length === 0) {
        alert("no files loaded!");
        return;
    }

    const found = await findHTML();
    if (!found) {
        alert("no html found!");
        return;
    }
    const finalHtml = await inlinePreset(found.html);

    async function buildZipInput(dir, path = '') {
        const out = {};
        for (const [key, value] of Object.entries(dir)) {
            const currentPath = path ? `${path}/${key}` : key;
            if (value instanceof Blob) {
                const source = currentPath === found.path ? new Blob([finalHtml]) : value;
                out[key] = new Uint8Array(await source.arrayBuffer());
            } else {
                out[key] = await buildZipInput(value, currentPath);
            }
        }
        return out;
    }

    const zipInput = await buildZipInput(fileTree);
    const blob = new Blob([fflate.zipSync(zipInput)], { type: 'application/zip' });

    if (window.showSaveFilePicker) {
        try {
            const handle = await window.showSaveFilePicker({
                suggestedName: 'archive.zip',
                types: [{ description: 'Zip Archive', accept: { 'application/zip': ['.zip'] } }]
            });
            const writable = await handle.createWritable();
            await writable.write(blob);
            await writable.close();
            return;
        } catch (err) {
            if (err.name === 'AbortError') return;
        }
    }

    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'archive.zip';
    a.click();
    URL.revokeObjectURL(a.href);
}

async function downloadSingleFile() {
    if (!confirm("Are you sure? Many features such as local fetch and ES modules do not work in local files, and generating this file may crash the tab!"))
        return;
    if (Object.keys(fileTree).length === 0)
        alert("no files loaded!")
    else {
        await checkPreset();
    }
}

async function checkPreset() {
    return await generatePreset();
    return await inlinePreset(preset);
}

async function findHTML() {
    // first check top level
    let html = null;
    let htmlPath = null;
    let dir = fileTree;

    // find an html to use, always takes the first index.html found, otherwise will take the furthest html it finds
    let foundIndex = false;
    function walk(dir, path = '') {
        for (const [key, value] of Object.entries(dir)) {
            // always use index.html if found
            if (foundIndex) return;
            const currentPath = path ? `${path}/${key}` : key;
            if (value instanceof Blob && key.toLowerCase().endsWith(".html")) {
                html = value;
                htmlPath = currentPath;
                if (key.toLowerCase() === "index.html") { foundIndex = true; return; }
            } else if (!(value instanceof Blob)) {
                walk(value, currentPath);
            }
        }
    }

    walk(dir);
    return html ? { html, path: htmlPath } : null;
}

async function generatePreset() {
    const found = await findHTML();
    return await inlinePreset(found ? found.html : null)
}

// get size of chunks
function getTotalSize(tree, predicate = () => true) {
    let total = 0;
    for (const [key, value] of Object.entries(tree)) {
        if (value instanceof Blob) {
            if (predicate(value, key)) total += value.size;
        } else {
            total += getTotalSize(value, predicate);
        }
    }
    return total;
}

// actual preset filling out stuff
async function inlinePreset(preset) {
    const htmlText = typeof preset === "string" ? preset : await preset.text();
    const html = new DOMParser().parseFromString(htmlText, "text/html");
    const base = document.getElementById("baseUrl").innerHTML;

    // patch fetch and xhr requests so that it detects split files and merges them (unminified patch and style are both in repo)
    const patch = `(${(function () { (() => { function t(t) { const e = { B: 1, KB: 1024, MB: 1048576, GB: 1024 ** 3, TB: 1024 ** 4, PB: 1024 ** 5 }; if ("string" == typeof t) { const n = t.trim().match(/^([\d.]+)\s*([BKMGTP])?B?$/i); if (!n) throw new Error(`bad size: ${t}`); const [, o, r = "B"] = n; return Math.round(parseFloat(o) * e[r.toUpperCase()]) } const n = ["B", "KB", "MB", "GB", "TB", "PB"]; let o = t, r = 0; for (; o >= 1024 && r < n.length - 1;)o /= 1024, r++; return `${o >= 100 || 0 === r ? o.toFixed(0) : o.toFixed(2)}${n[r]}` } window.snProgress = { loaded: 0, total: "50.62MB" }; const e = window.fetch.bind(window), n = window.XMLHttpRequest, o = n.prototype.open, r = n.prototype.send, a = new Map, s = new Map; function l(t) { return a.has(t) || a.set(t, (async () => { try { return (await e(t + ".part000", { method: "HEAD" })).ok } catch { return !1 } })()), a.get(t) } function c(t) { return s.has(t) || s.set(t, (async () => { const n = []; for (let o = 0; ; o++) { const r = t + ".part" + String(o).padStart(3, "0"); let a; try { a = await e(r, { method: "HEAD" }) } catch { break } if (!a.ok) break; const s = parseInt(a.headers.get("Content-Length") || "", 10); if (!Number.isFinite(s)) return null; n.push(s) } return n.length ? n : null })()), s.get(t) } async function* i(t) { for (let n = 0; ; n++) { const o = t + ".part" + String(n).padStart(3, "0"); let r; try { r = await e(o) } catch { return } if (!r.ok) return; const a = r.body.getReader(); for (; ;) { const { value: t, done: e } = await a.read(); if (e) break; yield t } } } window.fetch = async function (t, n = {}) { const o = "string" == typeof t ? t : t.url, r = (n.method || t && t.method || "GET").toUpperCase(); if (("GET" === r || "HEAD" === r) && await l(o)) { if ("HEAD" === r) { const t = await c(o), e = new Headers({ "Content-Type": "application/octet-stream" }); return t && e.set("Content-Length", String(t.reduce((t, e) => t + e, 0))), new Response(null, { status: 200, statusText: "OK", headers: e }) } const t = await c(o), e = new Headers({ "Content-Type": "application/octet-stream" }); return t && e.set("Content-Length", String(t.reduce((t, e) => t + e, 0))), new Response(function (t) { const e = i(t); return new ReadableStream({ async pull(t) { const { value: n, done: o } = await e.next(); o ? t.close() : t.enqueue(n) }, async cancel(t) { try { await e.return(t) } catch { } } }) }(o), { status: 200, statusText: "OK", headers: e }) } return e(t, n) }, n.prototype.open = function (t, e, ...n) { return this._snMethod = (t || "GET").toUpperCase(), this._snUrl = e, o.call(this, t, e, ...n) }, n.prototype.send = function (e) { const n = this, o = n._snUrl, a = n._snMethod, s = arguments; if ("GET" !== a && "HEAD" !== a) return r.apply(n, s); l(o).then(async e => { if (!e) return r.apply(n, s); const l = (t, e, o) => { const r = new e(t, o); n.dispatchEvent(r); const a = n["on" + t]; if ("function" == typeof a) try { a.call(n, r) } catch { } }, d = await c(o), u = d ? d.reduce((t, e) => t + e, 0) : 0, g = !!d; if ("HEAD" === a) { try { Object.defineProperties(n, { status: { configurable: !0, get: () => 200 }, statusText: { configurable: !0, get: () => "OK" }, readyState: { configurable: !0, get: () => 4 }, response: { configurable: !0, get: () => null } }) } catch { } return l("readystatechange", Event, {}), l("load", ProgressEvent, { lengthComputable: g, loaded: u, total: u }), void l("loadend", ProgressEvent, { lengthComputable: g, loaded: u, total: u }) } const p = []; let f = 0, h = !1; const y = () => { h = !0 }; n.addEventListener("abort", y); let w = 0; try { for await (const e of i(o)) { if (h) return; p.push(e), f += e.byteLength; const n = performance.now(); if (n - w > 100) { l("progress", ProgressEvent, { lengthComputable: g, loaded: f, total: u || f }), w = n; const e = document.getElementById("snMbText"); e && (e.textContent = t(f) + " / " + window.snProgress.total) } } l("progress", ProgressEvent, { lengthComputable: g, loaded: f, total: u || f }); const e = document.getElementById("snMbText"); e && (e.textContent = t(f) + " / " + window.snProgress.total); const n = document.getElementById("snLoadingBG"), r = document.getElementById("snLoadingTextHolder"); n && (n.style.visibility = "hidden"), r && (r.style.visibility = "hidden") } catch (t) { return l("error", ProgressEvent, { lengthComputable: !1, loaded: f, total: 0 }), void l("loadend", ProgressEvent, { lengthComputable: !1, loaded: f, total: 0 }) } finally { n.removeEventListener("abort", y) } const b = f, m = () => { const t = new Uint8Array(b); let e = 0; for (const n of p) t.set(n, e), e += n.byteLength; return t }, E = n.responseType; let B, v = null; if ("arraybuffer" === E) B = m().buffer; else if ("blob" === E) B = new Blob(p); else if ("json" === E) try { B = JSON.parse((new TextDecoder).decode(m())) } catch { B = null } else { const t = (new TextDecoder).decode(m()); B = t, v = () => t } try { const t = { status: { configurable: !0, get: () => 200 }, statusText: { configurable: !0, get: () => "OK" }, readyState: { configurable: !0, get: () => 4 }, response: { configurable: !0, get: () => B } }; v && (t.responseText = { configurable: !0, get: v }), Object.defineProperties(n, t) } catch { } window.snProgress.loaded = f, l("readystatechange", Event, {}), l("load", ProgressEvent, { lengthComputable: g, loaded: b, total: u || b }), l("loadend", ProgressEvent, { lengthComputable: g, loaded: b, total: u || b }) }) } })(); }).toString()})();`;
    const patchEl = html.createElement("script");
    patchEl.textContent = patch;
    html.head.prepend(patchEl);

    // prepend base if there is one or replace already existing base
    if (base !== "") {
        const b = html.getElementsByTagName("base");

        if (b.length !== 0) {
            b[0].href = base;
        } else {
            const el = html.createElement("base");
            el.href = base;
            html.head.prepend(el);
        }
    }

    // return html
    return "<!DOCTYPE html>\n" + html.documentElement.outerHTML;
}

// OTHER STUFF
function uploadPresetData() {
    const dropdown = document.getElementById("selectedPresetDropdown");
    const uploadButton = document.getElementById("uploadPresetFile");

    if (dropdown.value != "CreateNew") {
        if (!confirm("Are you sure? This will replace the data of the currently selected preset!"))
            return;
    }

    uploadButton.click();
}

function downloadPresetData() {
    const dropdown = document.getElementById("selectedPresetDropdown");
    const uploadButton = document.getElementById("uploadPresetFile");

    if (dropdown.value != "CreateNew") {
        if (!confirm("Are you sure? This will delete the data of the currently selected preset!"))
            return;
    }
}
