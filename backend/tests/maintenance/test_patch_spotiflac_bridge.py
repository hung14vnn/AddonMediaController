import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

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
    assert "transformPatternedBlocks: (inputPath, outputPath, opts, onProgress)" in patched
    assert "createDecipheriv('bf-cbc', key, iv)" in patched
    assert "transformEvery" in patched

    assert patch_bridge(bridge) is False
    assert bridge.read_text(encoding="utf-8") == patched


@pytest.mark.skipif(shutil.which("node") is None, reason="Node.js is required")
def test_patched_bridge_decrypts_every_third_full_block(tmp_path: Path):
    pytest.importorskip("cryptography")
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

    bridge = tmp_path / "_bridge.js"
    installed_bridge = next(
        (
            Path(root) / "SpotiFLAC" / "extensions" / "_bridge.js"
            for root in sys.path
            if root
            and (Path(root) / "SpotiFLAC" / "extensions" / "_bridge.js").is_file()
        ),
        None,
    )
    if installed_bridge is None:
        pytest.skip("SpotiFLAC bridge is not installed")
    shutil.copyfile(installed_bridge, bridge)
    assert patch_bridge(bridge) is True

    extension = tmp_path / "extension.js"
    extension.write_text(
        """registerExtension({
  download: function(input, output) {
    return file.transformPatternedBlocks(input, output, {
      operation: 'decrypt', algorithm: 'blowfish', mode: 'cbc',
      key: '000102030405060708090a0b0c0d0e0f', keyEncoding: 'hex',
      iv: '0001020304050607', ivEncoding: 'hex', padding: 'none',
      segmentSize: 16, transformEvery: 3, transformOffset: 0,
      transformPartial: false
    });
  }
});
""",
        encoding="utf-8",
    )

    key = bytes(range(16))
    iv = bytes(range(8))
    plain = bytes((index * 17) % 256 for index in range(16 * 4 + 5))
    encrypted_parts = []
    for block_index, start in enumerate(range(0, len(plain), 16)):
        block = plain[start : start + 16]
        if block_index % 3 == 0 and len(block) == 16:
            encryptor = Cipher(algorithms.Blowfish(key), modes.CBC(iv)).encryptor()
            block = encryptor.update(block) + encryptor.finalize()
        encrypted_parts.append(block)

    source = tmp_path / "encrypted.bin"
    target = tmp_path / "decrypted.bin"
    source.write_bytes(b"".join(encrypted_parts))

    process = subprocess.Popen(
        ["node", str(bridge), str(extension), "{}"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env={**os.environ, "NODE_OPTIONS": "--openssl-legacy-provider"},
        text=True,
    )
    try:
        ready = json.loads(process.stdout.readline())
        assert ready["type"] == "ready"
        process.stdin.write(
            json.dumps(
                {
                    "id": 1,
                    "call": "download",
                    "args": [str(source), str(target)],
                }
            )
            + "\n"
        )
        process.stdin.flush()
        result = json.loads(process.stdout.readline())
        assert result["result"]["success"] is True
    finally:
        process.stdin.close()
        process.wait(timeout=5)

    assert target.read_bytes() == plain
