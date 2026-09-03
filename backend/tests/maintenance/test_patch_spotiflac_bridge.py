from pathlib import Path

from maintenance.patch_spotiflac_bridge import patch_bridge


def _bridge_fixture() -> str:
    return """global.file = {
    download: (url, outputPath, opts) =>
      bridgeCall('file.download', { url, outputPath, opts: opts || {} }),
};

async function handleBridgeRequest() {
    if (method === 'something-else') {
      result = null;
    } else if (method === 'file.download') {
      result = await nodeFileDownload(args.url, args.outputPath, args.opts, callId);
    } else if (method === 'session.signedFetch') {
      result = await forwardToPython('session_signed_fetch', {});
    }
}

const worker = new Worker(__filename, { workerData: {} });
"""


def test_patch_bridge_adds_segment_api_and_is_idempotent(tmp_path: Path):
    bridge = tmp_path / "_bridge.js"
    bridge.write_text(_bridge_fixture(), encoding="utf-8")

    assert patch_bridge(bridge) is True
    patched = bridge.read_text(encoding="utf-8")
    assert "downloadSegments: (urls, outputPath, opts)" in patched
    assert "nodeFileDownloadSegments(args.urls" in patched
    assert "async function nodeFileDownloadSegments" in patched

    assert patch_bridge(bridge) is False
    assert bridge.read_text(encoding="utf-8") == patched
