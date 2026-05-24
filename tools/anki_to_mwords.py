#!/usr/bin/env python3
"""Convert an Anki text export into an mwords v2 import JSON file.

Anki's "Notes in Plain Text (.txt)" export looks like:

    #separator:tab
    #html:true
    #deck column:1
    #tags column:4
    deckName<TAB>front<TAB>back<TAB>tags

The deck/tags columns are optional. When `#deck column:N` is present each
row's deck-column value becomes an mwords **deck** name; when it's absent
the whole file lands in a single deck whose name comes from
`--default-deck` (or the input filename's stem). HTML is stripped from
`text`/`translation` when `#html:true` is set.

The output always contains **one mwords group** — its name is the
required `--group` argument — and one or more decks under it. v2 schema
matches docs/design.md → "Export and import":

    {"version": 2, "groups": [
      {"name": <group>, "decks": [
        {"name": <deck>, "words": [{"text": ..., "translation": ...}, ...]},
        ...
      ]}
    ]}
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import OrderedDict
from html import unescape
from pathlib import Path


HEADER_PREFIX = "#"
TAG_RE = re.compile(r"<[^>]+>")


class ParseError(Exception):
    pass


def parse_headers(lines: list[str]) -> tuple[dict[str, str], int]:
    """Return (headers, first_data_line_index)."""
    headers: dict[str, str] = {}
    i = 0
    for line in lines:
        if not line.startswith(HEADER_PREFIX):
            break
        # Anki headers are `#key:value` — split on the first colon only.
        body = line[len(HEADER_PREFIX) :]
        if ":" not in body:
            i += 1
            continue
        key, value = body.split(":", 1)
        headers[key.strip().lower()] = value.strip()
        i += 1
    return headers, i


def resolve_separator(headers: dict[str, str]) -> str:
    raw = headers.get("separator", "tab").lower()
    if raw == "tab" or raw == "\\t":
        return "\t"
    if raw == "comma":
        return ","
    if raw == "semicolon":
        return ";"
    if raw == "space":
        return " "
    # Fall back to a literal single character (Anki also writes the char itself
    # for non-named separators).
    if len(raw) == 1:
        return raw
    raise ParseError(f"Unsupported #separator value: {raw!r}")


def one_based(headers: dict[str, str], key: str) -> int | None:
    raw = headers.get(key)
    if raw is None:
        return None
    try:
        n = int(raw)
    except ValueError as exc:
        raise ParseError(f"#{key} must be an integer, got {raw!r}") from exc
    if n < 1:
        raise ParseError(f"#{key} must be >= 1, got {n}")
    return n


def strip_html(value: str) -> str:
    # Treat <br>/<br/> as line breaks before stripping the rest so multi-line
    # cards survive in a readable form.
    value = re.sub(r"<\s*br\s*/?\s*>", "\n", value, flags=re.IGNORECASE)
    value = TAG_RE.sub("", value)
    return unescape(value)


def normalise_cell(value: str, html: bool) -> str:
    if html:
        value = strip_html(value)
    return value.strip()


def convert(
    lines: list[str],
    group: str,
    default_deck: str,
) -> dict:
    headers, start = parse_headers(lines)
    sep = resolve_separator(headers)
    html = headers.get("html", "false").lower() == "true"
    deck_col = one_based(headers, "deck column")
    tags_col = one_based(headers, "tags column")

    # Decks indexed by name, in first-seen order, so the output preserves the
    # natural order of decks as they appear in the Anki file.
    decks: "OrderedDict[str, list[dict[str, str]]]" = OrderedDict()

    for lineno, raw in enumerate(lines[start:], start=start + 1):
        # Skip stray comments / blank lines mid-file. Anki doesn't normally
        # produce them but we may as well be lenient.
        if not raw.strip() or raw.startswith(HEADER_PREFIX):
            continue
        cells = raw.split(sep)

        if deck_col is not None:
            if len(cells) < deck_col:
                raise ParseError(
                    f"line {lineno}: expected at least {deck_col} columns for "
                    f"the deck column, got {len(cells)}"
                )
            deck_name = normalise_cell(cells[deck_col - 1], html=False)
            content = [c for i, c in enumerate(cells, start=1) if i != deck_col]
            if tags_col is not None and tags_col != deck_col:
                # Drop the tags column from the content too, accounting for the
                # shift introduced by removing the deck column above.
                adjusted = tags_col - 1 if tags_col > deck_col else tags_col
                if 1 <= adjusted <= len(content):
                    content.pop(adjusted - 1)
        else:
            deck_name = default_deck
            content = list(cells)
            if tags_col is not None and 1 <= tags_col <= len(content):
                content.pop(tags_col - 1)

        if len(content) < 2:
            raise ParseError(
                f"line {lineno}: expected text and translation columns, got "
                f"{len(content)} non-deck/tag column(s)"
            )

        text = normalise_cell(content[0], html=html)
        translation = normalise_cell(content[1], html=html)
        if not text or not translation:
            # Skip half-empty rows rather than importing blanks.
            continue
        if not deck_name:
            raise ParseError(f"line {lineno}: deck column is empty")

        decks.setdefault(deck_name, []).append(
            {"text": text, "translation": translation}
        )

    return {
        "version": 2,
        "groups": [
            {
                "name": group,
                "decks": [
                    {"name": name, "words": words}
                    for name, words in decks.items()
                ],
            }
        ],
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Convert an Anki tab-separated text export into an mwords v2 "
            "import JSON file. Always produces a single group; each row's "
            "deck-column value (or --default-deck) becomes a deck under it."
        )
    )
    parser.add_argument(
        "input",
        type=Path,
        help="Path to the Anki .txt export.",
    )
    parser.add_argument(
        "-g",
        "--group",
        required=True,
        help="Name of the (single) mwords group to wrap all decks under.",
    )
    parser.add_argument(
        "-o",
        "--output",
        type=Path,
        help="Output JSON path. Defaults to stdout.",
    )
    parser.add_argument(
        "--default-deck",
        default=None,
        help=(
            "Deck name to use when the file has no `#deck column:` header. "
            "Defaults to the input filename's stem."
        ),
    )
    parser.add_argument(
        "--pretty",
        action="store_true",
        help="Pretty-print the JSON (2-space indent). Default is minified.",
    )
    args = parser.parse_args(argv)

    try:
        text = args.input.read_text(encoding="utf-8-sig")
    except OSError as exc:
        print(f"error: cannot read {args.input}: {exc}", file=sys.stderr)
        return 1

    # splitlines() handles \n, \r\n, and \r uniformly and drops the trailing
    # newline so we don't get a phantom empty record.
    lines = text.splitlines()
    default_deck = args.default_deck or args.input.stem
    group = args.group.strip()
    if not group:
        print("error: --group must be a non-empty name", file=sys.stderr)
        return 1

    try:
        result = convert(lines, group=group, default_deck=default_deck)
    except ParseError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    if args.pretty:
        rendered = json.dumps(result, ensure_ascii=False, indent=2)
    else:
        rendered = json.dumps(result, ensure_ascii=False, separators=(",", ":"))

    if args.output:
        args.output.write_text(rendered, encoding="utf-8")
        decks = sum(len(g["decks"]) for g in result["groups"])
        words = sum(
            len(d["words"]) for g in result["groups"] for d in g["decks"]
        )
        print(
            f"wrote {args.output} — 1 group, {decks} deck(s), {words} word(s)",
            file=sys.stderr,
        )
    else:
        sys.stdout.write(rendered)
        if args.pretty:
            sys.stdout.write("\n")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
