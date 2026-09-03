"""Patch the SpotiFLAC JS bridge for the current segment-download extension API."""

from __future__ import annotations

import sys
from pathlib import Path


_WORKER_ANCHOR = """    download: (url, outputPath, opts) =>
      bridgeCall('file.download', { url, outputPath, opts: opts || {} }),
"""
_WORKER_REPLACEMENT = _WORKER_ANCHOR + """    downloadSegments: (urls, outputPath, opts) =>
      bridgeCall('file.downloadSegments', { urls, outputPath, opts: opts || {} }),
"""
_MAIN_ANCHOR = """    } else if (method === 'file.download') {
      result = await nodeFileDownload(args.url, args.outputPath, args.opts, callId);"""
_MAIN_REPLACEMENT = _MAIN_ANCHOR + """
    } else if (method === 'file.downloadSegments') {
      result = await nodeFileDownloadSegments(args.urls, args.outputPath, args.opts, callId);"""

# This function intentionally uses the same streaming/redirect conventions as
# nodeFileDownload.  It downloads each segment to a private sibling directory,
# then concatenates init + media segments in order into the requested path.
_SEGMENT_FUNCTION = r'''
async function nodeFileDownloadSegments(rawUrls, outputPath, opts, callId) {
  const urls = Array.isArray(rawUrls)
    ? rawUrls.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  if (!urls.length) return { success: false, error: 'No segment URLs provided' };

  if (typeof global.__spotiflacAllowWrite === 'function') {
    global.__spotiflacAllowWrite(outputPath);
  }

  const options = opts || {};
  const maxParallel = Math.max(1, Math.min(16, Number(options.maxParallel) || 4));
  const partDir = `${outputPath}.segments`;
  const temporaryOutput = `${outputPath}.segments.tmp`;
  const parts = urls.map((_, i) => path.join(partDir, `${String(i).padStart(6, '0')}.part`));
  let nextIndex = 0;
  let completed = 0;
  let written = 0;
  let totalBytes = 0;
  let lastReportedBytes = 0;

  const emitProgress = (finalValue) => {
    if (!callId) return;
    const value = finalValue !== undefined
      ? finalValue
      : (totalBytes > 0 ? Math.min(0.999, written / totalBytes) : completed / urls.length);
    process.stdout.write(JSON.stringify({
      type: 'progress', callId, value,
      bytesReceived: written, bytesTotal: totalBytes,
      completedSegments: completed, totalSegments: urls.length,
    }) + '\n');
    lastReportedBytes = written;
  };

  const cleanup = () => {
    try { fs.rmSync(partDir, { recursive: true, force: true }); } catch (_) {}
    try { fs.unlinkSync(temporaryOutput); } catch (_) {}
  };

  const downloadOne = (rawUrl, partPath, redirectDepth = 0) =>
    new Promise((resolve, reject) => {
      let u;
      try { u = new URL(rawUrl); } catch (_) {
        reject(new Error(`Invalid segment URL: ${rawUrl}`));
        return;
      }
      if (redirectDepth > 5) {
        reject(new Error('Too many redirects while downloading a segment'));
        return;
      }
      const lib = u.protocol === 'https:' ? https : http_;
      const request = lib.request({
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'GET',
        headers: Object.assign({}, options.headers || {}),
      }, (response) => {
        const location = response.headers.location;
        if ([301, 302, 303, 307, 308].includes(response.statusCode) && location) {
          response.resume();
          downloadOne(new URL(location, u).toString(), partPath, redirectDepth + 1)
            .then(resolve, reject);
          return;
        }
        if (response.statusCode >= 400) {
          response.resume();
          reject(new Error(`HTTP ${response.statusCode} while downloading segment`));
          return;
        }
        const declaredSize = parseInt(response.headers['content-length'] || '0', 10) || 0;
        if (declaredSize > 0) totalBytes += declaredSize;
        const stream = fs.createWriteStream(partPath);
        const fail = (error) => {
          try { stream.destroy(); } catch (_) {}
          try { fs.unlinkSync(partPath); } catch (_) {}
          reject(error);
        };
        response.on('data', (chunk) => {
          written += chunk.length;
          if (written - lastReportedBytes >= 128 * 1024) emitProgress();
        });
        response.on('error', fail);
        stream.on('error', fail);
        stream.on('finish', () => {
          stream.close(() => {
            try { resolve(fs.statSync(partPath).size); } catch (error) { fail(error); }
          });
        });
        response.pipe(stream);
      });
      request.on('error', reject);
      request.setTimeout(120000, () => {
        request.destroy();
        reject(new Error('Segment download timeout'));
      });
      request.end();
    });

  const runWorker = async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= urls.length) return;
      await downloadOne(urls[index], parts[index]);
      completed += 1;
      emitProgress();
    }
  };

  try {
    fs.mkdirSync(partDir, { recursive: true });
    await Promise.all(Array.from({ length: Math.min(maxParallel, urls.length) }, runWorker));

    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(temporaryOutput);
      let index = 0;
      let failed = false;
      const fail = (error) => {
        if (failed) return;
        failed = true;
        output.destroy();
        reject(error);
      };
      output.on('error', fail);
      const appendNext = () => {
        if (failed) return;
        if (index >= parts.length) {
          output.end(resolve);
          return;
        }
        const input = fs.createReadStream(parts[index++]);
        input.on('error', fail);
        input.on('end', appendNext);
        input.pipe(output, { end: false });
      };
      appendNext();
    });

    try { fs.unlinkSync(outputPath); } catch (_) {}
    fs.renameSync(temporaryOutput, outputPath);
    const size = fs.statSync(outputPath).size;
    if (size <= 0) throw new Error('Concatenated segment file is empty');
    emitProgress(1);
    try { fs.rmSync(partDir, { recursive: true, force: true }); } catch (_) {}
    return { success: true, path: outputPath, size };
  } catch (error) {
    cleanup();
    return { success: false, error: error && error.message ? error.message : String(error) };
  }
}

'''


def _bridge_paths() -> list[Path]:
    return list(
        dict.fromkeys(
            Path(root) / "SpotiFLAC" / "extensions" / "_bridge.js"
            for root in sys.path
            if root and (Path(root) / "SpotiFLAC" / "extensions" / "_bridge.js").is_file()
        )
    )


def patch_bridge(path: Path) -> bool:
    source = path.read_text(encoding="utf-8")
    if "downloadSegments: (urls, outputPath, opts)" in source:
        return False
    if _WORKER_ANCHOR not in source or _MAIN_ANCHOR not in source:
        raise RuntimeError(f"Unsupported SpotiFLAC bridge layout: {path}")
    source = source.replace(_WORKER_ANCHOR, _WORKER_REPLACEMENT, 1)
    source = source.replace(_MAIN_ANCHOR, _MAIN_REPLACEMENT, 1)
    startup_anchor = "const worker = new Worker(__filename"
    if startup_anchor not in source:
        raise RuntimeError(f"Could not find worker startup anchor: {path}")
    source = source.replace(startup_anchor, _SEGMENT_FUNCTION + startup_anchor, 1)
    path.write_text(source, encoding="utf-8", newline="\n")
    return True


def main() -> int:
    paths = _bridge_paths()
    if not paths:
        raise SystemExit("SpotiFLAC bridge not found; dependency installation is incomplete")
    for path in paths:
        changed = patch_bridge(path)
        print(f"{'patched' if changed else 'already patched'} {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
