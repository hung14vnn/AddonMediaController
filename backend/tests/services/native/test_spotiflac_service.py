from services.native.spotiflac_service import spotiflac_client_options


def test_low_quality_uses_lossy_youtube_provider():
    options = spotiflac_client_options("/downloads", "LOW")

    assert options == {
        "output_dir": "/downloads",
        "quality": "LOW",
        "services": ["youtube"],
        "allow_fallback": False,
        "use_extensions_fallback": False,
    }


def test_high_quality_uses_standard_provider_fallbacks():
    options = spotiflac_client_options("/downloads", "HIGH")

    assert options["services"] == ["tidal", "qobuz", "deezer", "amazon", "apple"]


def test_lossless_quality_preserves_provider_output():
    options = spotiflac_client_options("/downloads", "LOSSLESS")

    assert options["services"] == ["tidal", "qobuz", "deezer", "amazon", "apple"]
