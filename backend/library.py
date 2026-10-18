"""Read-only browsing of sources with approved evidence.

Library metadata comes from existing source records and approved annotations.
Attributes are annotation labels, not inferred property values. Objects are
grouped only within their source; no cross-source identity is inferred.
"""

import re

from backend.library_visuals import load_visual_manifest, source_visuals


_LOCATOR = re.compile(r"chars:([0-9]+):([0-9]+)\Z")
_CATALOG_NUMBER = re.compile(r"(?<![A-Za-z0-9])MFB[0-9]+(?![A-Za-z0-9])")


def _rows(connection, query, parameters=()):
    """Support both default and sqlite3.Row connections without changing them."""
    cursor = connection.execute(query, parameters)
    names = [column[0] for column in cursor.description]
    return [dict(zip(names, row)) for row in cursor.fetchall()]


def _unique(values):
    return list(dict.fromkeys(value for value in values if value))


def _tags(value):
    return _unique(value.split())


def _catalog_numbers(evidence):
    # A source may mention additional objects outside its approved excerpts.
    # Only approved annotations and excerpts establish these searchable IDs.
    return _unique(
        number
        for item in evidence
        for field in ("object_name", "aliases", "attribute", "keywords", "evidence_text")
        for number in _CATALOG_NUMBER.findall(item[field])
    )


def _approved_rows(connection, source_id=None):
    query = (
        "SELECT id, source_id, object_name, aliases, attribute, keywords, "
        "evidence_text, locator FROM evidence_chunks "
        "WHERE review_status = 'approved'"
    )
    parameters = ()
    if source_id is not None:
        query += " AND source_id = ?"
        parameters = (source_id,)
    return _rows(connection, query + " ORDER BY source_id, id", parameters)


def list_library(connection):
    """Return stable source cards and truthful counts from approved evidence."""
    approved = _approved_rows(connection)
    manifest = load_visual_manifest()
    by_source = {}
    for item in approved:
        by_source.setdefault(item["source_id"], []).append(item)

    sources = []
    for source in _rows(
        connection,
        "SELECT id, case_id, title, publisher, source_url, retrieved_at FROM sources ORDER BY id",
    ):
        evidence = by_source.get(source["id"])
        if not evidence:
            continue
        preview = " ".join(evidence[0]["evidence_text"].split())
        visuals = source_visuals(source, evidence, manifest)
        sources.append({
            **{key: value for key, value in source.items() if key != "case_id"},
            "object_names": _unique(item["object_name"] for item in evidence),
            "aliases": _unique(tag for item in evidence for tag in _tags(item["aliases"])),
            "attributes": _unique(tag for item in evidence for tag in _tags(item["attribute"])),
            "keywords": _unique(tag for item in evidence for tag in _tags(item["keywords"])),
            "catalog_numbers": _catalog_numbers(evidence),
            "evidence_count": len(evidence),
            "visual_count": len(visuals),
            "cover": ({key: visuals[0][key] for key in ("url", "alt", "width", "height")}
                      if visuals else None),
            "excerpt": preview[:160] + ("…" if len(preview) > 160 else ""),
        })
    return {
        "sources": sources,
        "stats": {
            "available_sources": len(sources),
            "approved_evidence": sum(source["evidence_count"] for source in sources),
        },
        "attributes": _unique(tag for source in sources for tag in source["attributes"]),
        "publishers": _unique(source["publisher"] for source in sources),
    }


def _verified_offsets(original_text, item):
    match = _LOCATOR.fullmatch(item["locator"])
    if match:
        # Bound numeric length before int() so malformed imported locators
        # cannot hit Python's integer-string conversion limit.
        digits = len(str(len(original_text)))
        if any(len(value.lstrip("0") or "0") > digits for value in match.groups()):
            return None, None
        start, end = (int(value.lstrip("0") or "0") for value in match.groups())
        if 0 <= start < end <= len(original_text) and original_text[start:end] == item["evidence_text"]:
            return start, end
    return None, None


def get_library_source(connection, source_id):
    """Return one source and approved objects/evidence, or None if unavailable.

    Valid offsets use Python Unicode character indexes, not UTF-16 code units.
    A locator is actionable only when its exact source slice matches the saved
    excerpt. Invalid or stale locators retain their original label for review.
    """
    sources = _rows(
        connection,
        "SELECT id, case_id, title, publisher, source_url, retrieved_at, original_text "
        "FROM sources WHERE id = ?",
        (source_id,),
    )
    if not sources:
        return None
    source = sources[0]
    approved = _approved_rows(connection, source["id"])
    if not approved:
        return None

    objects = {}
    evidence = []
    for item in approved:
        aliases = _tags(item["aliases"])
        attributes = _tags(item["attribute"])
        current = objects.setdefault(item["object_name"], {
            "name": item["object_name"], "aliases": [], "attributes": [], "evidence_ids": [],
        })
        current["aliases"] = _unique([*current["aliases"], *aliases])
        current["attributes"] = _unique([*current["attributes"], *attributes])
        current["evidence_ids"].append(item["id"])
        start, end = _verified_offsets(source["original_text"], item)
        evidence.append({
            "id": item["id"], "object_name": item["object_name"],
            "aliases": aliases, "attributes": attributes, "keywords": _tags(item["keywords"]),
            "text": item["evidence_text"], "locator": item["locator"],
            "start": start, "end": end, "locator_verified": start is not None,
        })
    return {
        "source": {key: value for key, value in source.items() if key != "case_id"},
        "visuals": source_visuals(source, approved),
        "objects": list(objects.values()),
        "evidence": evidence,
        "catalog_numbers": _catalog_numbers(approved),
        "evidence_count": len(evidence),
    }
