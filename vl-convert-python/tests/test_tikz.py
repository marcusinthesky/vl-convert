"""Public Python contracts for scenegraph-based TikZ conversion."""

import asyncio
import json

import pytest
import vl_convert as vlc
import vl_convert.asyncio as vlca


def text_spec(label):
    return {
        "width": 120,
        "height": 40,
        "data": {"values": [{"label": label}]},
        "mark": {"type": "text", "align": "left"},
        "encoding": {"text": {"field": "label"}},
    }


@pytest.mark.parametrize("input_format", ["dict", "json"])
def test_tikz_plain_text_and_vega_parity(input_format):
    spec = text_spec("cost_50% & tax")
    vega = vlc.vegalite_to_vega(spec)
    input_spec = json.dumps(spec) if input_format == "json" else spec
    result = vlc.vegalite_to_tikz(input_spec)

    assert isinstance(result, str)
    assert r"\begin{tikzpicture}" in result
    assert r"\end{tikzpicture}" in result
    assert r"cost\_50\% \& tax" in result
    assert result == vlc.vega_to_tikz(vega)


def test_tikz_raw_text_is_explicit():
    spec = text_spec(r"$\alpha_1^2$")
    raw = vlc.vegalite_to_tikz(spec, text_mode="raw")
    plain = vlc.vegalite_to_tikz(spec)
    assert r"$\alpha_1^2$" in raw
    assert r"$\alpha_1^2$" not in plain
    assert r"\$" in plain


@pytest.mark.parametrize("name", ["vega_to_tikz", "vegalite_to_tikz"])
def test_tikz_rejects_invalid_text_mode(name):
    with pytest.raises(ValueError, match="Invalid text_mode"):
        getattr(vlc, name)({}, text_mode="invalid")


def test_tikz_async_matches_sync_and_preserves_errors():
    spec = text_spec(r"$\beta_2$")
    vega = vlc.vegalite_to_vega(spec)
    expected = vlc.vegalite_to_tikz(spec, text_mode="raw", width=200, height=60)

    async def scenario():
        assert (
            await vlca.vegalite_to_tikz(spec, text_mode="raw", width=200, height=60)
            == expected
        )
        assert await vlca.vega_to_tikz(
            vega, text_mode="raw", width=200, height=60
        ) == vlc.vega_to_tikz(vega, text_mode="raw", width=200, height=60)
        for name in ("vega_to_tikz", "vegalite_to_tikz"):
            with pytest.raises(ValueError, match="Invalid text_mode"):
                await getattr(vlca, name)({}, text_mode="invalid")

    asyncio.run(scenario())


def test_tikz_locale_and_config_are_forwarded():
    spec = {
        "width": 120,
        "height": 40,
        "data": {"values": [{"value": 1234.5}]},
        "mark": "text",
        "encoding": {
            "text": {"field": "value", "type": "quantitative", "format": "$,.1f"}
        },
    }
    result = vlc.vegalite_to_tikz(
        spec,
        format_locale={
            "decimal": "d",
            "thousands": "t",
            "grouping": [3],
            "currency": ["X", ""],
        },
        config={"text": {"fontWeight": "bold"}},
    )
    assert "X1t234d5" in result
    assert r"\bfseries" in result


def test_tikz_error_does_not_poison_next_conversion():
    unsupported = {
        "width": 40,
        "height": 40,
        "marks": [
            {
                "type": "image",
                "encode": {
                    "enter": {
                        "url": {"value": "data:image/png;base64,"},
                        "width": {"value": 20},
                        "height": {"value": 20},
                    }
                },
            }
        ],
    }
    expected = vlc.vegalite_to_tikz(text_spec("after"))
    with pytest.raises(ValueError, match="[Ii]mage"):
        vlc.vega_to_tikz(unsupported)
    assert vlc.vegalite_to_tikz(text_spec("after")) == expected
