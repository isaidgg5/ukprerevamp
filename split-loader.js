/* split-loader.js
 * Reassembles >20MB files split by split.py (<name>.part0, .part1, ...)
 * before the Unity game runs. Transparent to Unity: patches fetch + XHR
 * so requests for the original path are served from parts.
 *
 * Hookup in index.html (before build.loader.js is appended):
 *   <script src="split-loader.js"></script>
 *   ... await window.splitloader.ready before createUnityInstance ...
 *
 * Manifest: split-manifest.json at web root:
 *   {"version":1,"files":{"Build/build.wasm":{"size":52604318,
 *     "parts":["Build/build.wasm.part0",...],"sha256":"..."}}}
 */
(function () {
  "use strict";
  var manifest_url = "split-manifest.json";
  var cache = new Map(); // relPath -> Promise<ArrayBuffer>

  function contenttypefor(path) {
    if (/\.wasm(\?|#|$)/.test(path)) return "application/wasm";
    if (/\.js(\?|#|$)/.test(path)) return "application/javascript; charset=UTF-8";
    if (/\.data(\?|#|$)/.test(path)) return "application/octet-stream";
    if (/\.bundle(\?|#|$)/.test(path)) return "application/octet-stream";
    if (/\.json(\?|#|$)/.test(path)) return "application/json";
    return "application/octet-stream";
  }

  // "https://host/StreamingAssets/aa/WebGL/x.bundle?v=1" -> "StreamingAssets/aa/WebGL/x.bundle"
  function normalize(url) {
    try {
      var u = new URL(url, document.baseURI);
      var p = decodeURIComponent(u.pathname);
      if (p.charAt(0) === "/") p = p.slice(1);
      return p;
    } catch (e) {
      var s = String(url).split("?")[0].split("#")[0];
      s = s.replace(/^\.\//, "").replace(/^\//, "");
      try { s = decodeURIComponent(s); } catch (e2) {}
      return s;
    }
  }

  function parserange(header, total) {
    // "bytes=0-1048575" -> {start,end}; suffix/open ranges supported
    var m = /^bytes=(\d*)-(\d*)$/.exec((header || "").trim());
    if (!m) return null;
    var start, end;
    if (m[1] === "" && m[2] !== "") {
      var suffix = parseInt(m[2], 10);
      if (isNaN(suffix) || suffix <= 0) return null;
      start = Math.max(0, total - suffix);
      end = total - 1;
    } else {
      start = m[1] === "" ? 0 : parseInt(m[1], 10);
      end = m[2] === "" ? total - 1 : parseInt(m[2], 10);
      if (isNaN(start) || isNaN(end)) return null;
      if (start >= total) return null;
      end = Math.min(end, total - 1);
      if (end < start) return null;
    }
    return { start: start, end: end };
  }

  var manifestpromise = fetch(manifest_url, { credentials: "same-origin" })
    .then(function (r) {
      if (!r.ok) {
        console.warn("[split-loader] no manifest (" + r.status + "), passthrough");
        return { version: 1, files: {} };
      }
      return r.json();
    })
    .catch(function (e) {
      console.warn("[split-loader] manifest fetch failed, passthrough", e);
      return { version: 1, files: {} };
    });

  var manifest = { version: 1, files: {} };
  var ready = manifestpromise.then(function (m) {
    manifest = m && m.files ? m : { version: 1, files: {} };
    var n = Object.keys(manifest.files).length;
    console.log("[split-loader] ready, " + n + " split file(s)");
    return manifest;
  });

  function entryfor(url) {
    var rel = normalize(url);
    var e = manifest.files[rel];
    if (e) return { rel: rel, entry: e };
    return null;
  }

  function fetchpart(url) {
    return origfetch(url, { credentials: "same-origin" }).then(function (r) {
      if (!r.ok) throw new Error("part fetch " + r.status + " for " + url);
      return r.arrayBuffer();
    });
  }

  function getassembly(rel, entry) {
    var hit = cache.get(rel);
    if (hit) return hit;
    var p = Promise.all(entry.parts.map(fetchpart)).then(function (bufs) {
      var total = entry.size;
      var out = new Uint8Array(total);
      var off = 0;
      for (var i = 0; i < bufs.length; i++) {
        var u8 = new Uint8Array(bufs[i]);
        out.set(u8, off);
        off += u8.length;
      }
      if (off !== total) throw new Error("size mismatch for " + rel);
      return out.buffer;
    });
    cache.set(rel, p);
    // Drop failed assemblies so a retry refetches.
    p.catch(function () { cache.delete(rel); });
    return p;
  }

  function headersfor(rel, total, range) {
    var h = {
      "Content-Type": contenttypefor(rel),
      "Accept-Ranges": "bytes",
      "Content-Length": String(range ? range.end - range.start + 1 : total),
      "X-Split-Loader": "assembled"
    };
    if (range) h["Content-Range"] = "bytes " + range.start + "-" + range.end + "/" + total;
    return h;
  }

  var origfetch = window.fetch.bind(window);

  window.fetch = function (url, opts) {
    opts = opts || {};
    var urlstr = typeof url === "string" ? url : (url && url.url ? url.url : null);
    var method = (opts.method || (url && url.method) || "GET").toUpperCase();
    var found = urlstr ? entryfor(urlstr) : null;
    if (!found) return origfetch(url, opts);
    var rel = found.rel, entry = found.entry;

    if (method === "HEAD") {
      return Promise.resolve(
        new Response(null, { status: 200, headers: headersfor(rel, entry.size, null) })
      );
    }
    if (method !== "GET") return origfetch(url, opts);

    var rangeheader =
      (opts.headers instanceof Headers && opts.headers.get("Range")) ||
      (opts.headers && opts.headers["Range"]) ||
      (opts.headers && opts.headers["range"]) ||
      (url && url.headers instanceof Headers && url.headers.get("Range")) ||
      null;
    var range = rangeheader ? parserange(rangeheader, entry.size) : null;
    if (rangeheader && !range) {
      return Promise.resolve(new Response(null, { status: 416 }));
    }
    return getassembly(rel, entry).then(function (ab) {
      var body = range ? ab.slice(range.start, range.end + 1) : ab;
      return new Response(body, {
        status: range ? 206 : 200,
        headers: headersfor(rel, entry.size, range)
      });
    });
  };

  // Unity falls back to XHR on some paths; intercept those too.
  var origxhr = window.XMLHttpRequest;
  function splitxhr() {
    var xhr = new origxhr();
    var self = this;
    var requrl = null, reqmethod = "GET", reqheaders = {};
    var abortfn = null;

    this.open = function (method, url) {
      reqmethod = (method || "GET").toUpperCase();
      requrl = url;
      return xhr.open.apply(xhr, arguments);
    };
    this.setRequestHeader = function (k, v) {
      reqheaders[k] = v;
      return xhr.setRequestHeader.apply(xhr, arguments);
    };
    Object.defineProperty(this, "responseURL", { get: function () { return xhr.responseURL; } });

    ["readyState", "status", "statusText", "response", "responseText", "responseType", "timeout", "withCredentials", "upload", "onreadystatechange", "onload", "onerror", "onprogress", "ontimeout", "onabort", "onloadend", "onloadstart"].forEach(function (prop) {
      if (prop in xhr) {
        try {
          Object.defineProperty(self, prop, {
            get: function () { return self._done && (prop === "response" || prop === "responseText" || prop === "status" || prop === "statusText" || prop === "readyState") ? self["_" + prop] : xhr[prop]; },
            set: function (v) { xhr[prop] = v; },
            configurable: true
          });
        } catch (e) {}
      }
    });
    this.addEventListener = xhr.addEventListener.bind(xhr);
    this.removeEventListener = xhr.removeEventListener.bind(xhr);
    this.dispatchEvent = xhr.dispatchEvent.bind(xhr);
    this.overrideMimeType = xhr.overrideMimeType.bind(xhr);
    this.getAllResponseHeaders = function () {
      return self._respheaders || xhr.getAllResponseHeaders.apply(xhr, arguments);
    };
    this.getResponseHeader = function (k) {
      if (self._respheadermap) {
        var v = self._respheadermap[k.toLowerCase()];
        return v !== undefined ? v : null;
      }
      return xhr.getResponseHeader.apply(xhr, arguments);
    };
    this.abort = function () {
      if (abortfn) abortfn();
      return xhr.abort.apply(xhr, arguments);
    };
    this.send = function () {
      var found = typeof requrl === "string" ? entryfor(requrl) : null;
      if (!found || (reqmethod !== "GET" && reqmethod !== "HEAD")) {
        return xhr.send.apply(xhr, arguments);
      }
      var rel = found.rel, entry = found.entry;
      var cancelled = false;
      abortfn = function () { cancelled = true; };
      function fire(type) {
        var ev;
        try { ev = new ProgressEvent(type); } catch (e) { ev = document.createEvent("Event"); ev.initEvent(type, false, false); }
        if (typeof xhr["on" + type] === "function") { try { xhr["on" + type](ev); } catch (e) {} }
        try { xhr.dispatchEvent(ev); } catch (e) {}
        if (typeof self["on" + type] === "function") { try { self["on" + type](ev); } catch (e) {} }
      }
      function statustextfor(s) {
        return s === 200 ? "OK" : s === 206 ? "Partial Content" : s === 416 ? "Range Not Satisfiable" : "";
      }
      function finish(status, body, range) {
        if (cancelled) return;
        self._status = status;
        self._statusText = statustextfor(status);
        self._respheaders = Object.keys(headersfor(rel, entry.size, range)).map(function (k) { return k + ": " + headersfor(rel, entry.size, range)[k]; }).join("\r\n");
        self._respheadermap = {};
        Object.keys(headersfor(rel, entry.size, range)).forEach(function (k) { self._respheadermap[k.toLowerCase()] = headersfor(rel, entry.size, range)[k]; });
        var rt = xhr.responseType;
        if (reqmethod === "HEAD" || status === 416) {
          self._response = rt === "arraybuffer" ? new ArrayBuffer(0) : "";
          self._responseText = "";
        } else if (rt === "arraybuffer") {
          self._response = body;
          self._responseText = "";
        } else if (rt === "json") {
          try { self._response = JSON.parse(new TextDecoder().decode(body)); } catch (e) { self._response = null; }
          try { self._responseText = new TextDecoder().decode(body); } catch (e) { self._responseText = ""; }
        } else if (rt === "blob") {
          self._response = new Blob([body], { type: contenttypefor(rel) });
          try { self._responseText = ""; } catch (e) { self._responseText = ""; }
        } else {
          try { self._response = new TextDecoder().decode(body); } catch (e) { self._response = ""; }
          try { self._responseText = new TextDecoder().decode(body); } catch (e) { self._responseText = ""; }
        }
        self._readyState = 4;
        self._done = true;
        fire("readystatechange");
        fire("progress");
        fire("load");
        fire("loadend");
      }
      if (reqmethod === "HEAD") {
        finish(200, null, null);
        return;
      }
      var range = parserange(reqheaders["Range"] || reqheaders["range"] || "", entry.size);
      if ((reqheaders["Range"] || reqheaders["range"]) && !range) {
        finish(416, new ArrayBuffer(0), null);
        return;
      }
      getassembly(rel, entry).then(
        function (ab) {
          finish(range ? 206 : 200, range ? ab.slice(range.start, range.end + 1) : ab, range);
        },
        function () { xhr.send.apply(xhr, arguments); }
      );
    };
  }
  splitxhr.prototype = origxhr.prototype;
  window.XMLHttpRequest = splitxhr;

  window.splitloader = {
    ready: ready,
    get manifest() { return manifest; },
    clearcache: function () { cache.clear(); }
  };
})();
