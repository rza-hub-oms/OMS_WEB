# plc/tag_table_import.py
"""
Turns a TIA Portal PLC tag table Excel export (Project tree -> PLC tags
-> right-click a tag table -> "Export") into ready-to-use PLC
addresses -- either OMS S7 addresses or candidate OPC UA Node IDs --
mirroring plc/s7_db_import.py's two entry points but for tag tables
instead of Data Blocks.

Expected columns (TIA's default export header row, any order):
    Name | Path | Data Type | Logical Address | Comment | ...
Only Name, Data Type, and Logical Address are used; extra columns
(Comment, Hmi Visible, ...) are ignored.

Logical Address is TIA's own notation for physical/memory addresses,
e.g. "%M0.0", "%Q0.0", "%I0.1", "%MW10", "%MD20" -- the same area
letters (I/Q/M) OMS's S7 backend already parses (see plc/plc_sync.py's
S7Address / _S7_IO_ADDRESS_RE), just with a leading "%" TIA adds and
OMS doesn't. DB-relative tags (tags that live inside a Data Block
rather than a PLC tag table) don't have a Logical Address here at all
-- use s7_db_import.py's "Generate source" import for those instead.
"""

import re
from io import BytesIO

try:
    import openpyxl
    _OPENPYXL_AVAILABLE = True
except ImportError:
    _OPENPYXL_AVAILABLE = False


class TagTableImportError(Exception):
    """Raised for a file OMS can't make sense of at all (missing
    header row, no openpyxl installed, ...). Per-row problems are
    collected as warnings instead, so a partial import is still
    useful."""


# TIA's tag-table Data Type names -> (OMS dtype letter/name for S7
# addressing). Matches the scalar types plc/plc_sync.py's S7Address
# already understands; anything else is reported as a warning.
_DATA_TYPE_MAP = {
    "BOOL": "BOOL",
    "BYTE": "B",
    "WORD": "W",
    "DWORD": "DWORD",
    "INT": "INT",
    "DINT": "DINT",
    "REAL": "REAL",
}

_HEADER_ALIASES = {
    "name": "name",
    "data type": "data_type",
    "logical address": "logical_address",
}


def _find_header_row(rows):
    """Scans the first several rows for one containing all three
    required headers (case-insensitive) and returns
    (row_index, {field: column_index}). TIA's export normally has the
    header on row 1, but this tolerates a stray title row above it."""
    for row_idx, row in enumerate(rows[:5]):
        col_map = {}
        for col_idx, cell in enumerate(row):
            if cell is None:
                continue
            key = _HEADER_ALIASES.get(str(cell).strip().lower())
            if key:
                col_map[key] = col_idx
        if {"name", "data_type", "logical_address"} <= col_map.keys():
            return row_idx, col_map
    return None, None


def _strip_percent(address):
    """TIA's Logical Address column is prefixed with '%' (e.g.
    "%M0.0"); OMS's S7Address parser expects the bare form ("M0.0")."""
    return address.lstrip("%").strip()


def _parse_workbook_rows(file_bytes):
    if not _OPENPYXL_AVAILABLE:
        raise TagTableImportError(
            "The 'openpyxl' package is not installed in this Python "
            "environment. Install it with: pip install openpyxl"
        )

    try:
        wb = openpyxl.load_workbook(BytesIO(file_bytes), data_only=True, read_only=True)
    except Exception as exc:
        raise TagTableImportError(f"Couldn't read that file as an .xlsx workbook: {exc}")

    # TIA exports the tag table onto the first sheet ("PLC Tags" by
    # default) and a second "TagTable Properties" sheet OMS doesn't
    # need -- always read the first sheet, regardless of its title.
    ws = wb.worksheets[0]
    rows = [list(row) for row in ws.iter_rows(values_only=True)]

    header_idx, col_map = _find_header_row(rows)
    if header_idx is None:
        raise TagTableImportError(
            'Couldn\'t find a header row with "Name", "Data Type", and '
            '"Logical Address" columns -- make sure this is TIA Portal\'s '
            "PLC tag table export, not a Data Block export."
        )

    return rows[header_idx + 1:], col_map


def _extract_entries(file_bytes):
    """Shared front half of both public entry points below. Returns
    (entries, warnings) where each entry is
    {"name", "data_type", "logical_address"} for a row that had all
    three fields populated; blank/short rows are skipped silently
    (trailing blank rows are normal in TIA's export), and every
    non-blank row missing a piece is reported as a warning."""
    data_rows, col_map = _parse_workbook_rows(file_bytes)

    entries = []
    warnings = []

    for row in data_rows:
        def get(field):
            idx = col_map[field]
            return row[idx] if idx < len(row) else None

        name = get("name")
        data_type = get("data_type")
        address = get("logical_address")

        if name is None and data_type is None and address is None:
            continue  # blank spacer row

        name = str(name).strip() if name is not None else ""
        if not name:
            continue

        if address is None or not str(address).strip():
            warnings.append(f"{name}: no Logical Address set -- skipped.")
            continue

        entries.append({
            "name": name,
            "data_type": str(data_type).strip() if data_type is not None else "",
            "logical_address": str(address).strip(),
        })

    if not entries:
        warnings.append(
            "No tags with a Logical Address found. DB-relative tags "
            "(no physical %I/%Q/%M address) aren't importable this way -- "
            "use the DB source text import instead."
        )

    return entries, warnings


def parse_tag_table_xlsx(file_bytes):
    """Parses a TIA Portal PLC tag table .xlsx export into S7
    addresses.

    Returns (tags, warnings):
      tags     -- [{"name", "dtype", "address"}, ...], ready to use as
                  S7 Mapping panel node addresses.
      warnings -- human-readable strings for rows that were skipped
                  (no address, unsupported data type).

    Raises TagTableImportError if the file can't be read at all, or
    openpyxl isn't installed.
    """
    entries, warnings = _extract_entries(file_bytes)

    tags = []
    for entry in entries:
        upper_type = entry["data_type"].upper()
        if upper_type not in _DATA_TYPE_MAP:
            warnings.append(
                f'{entry["name"]}: unsupported Data Type {entry["data_type"]!r} '
                f"for S7 addressing (STRING, UDTs, ... aren't resolvable from "
                f"a Logical Address alone) -- skipped."
            )
            continue

        address = _strip_percent(entry["logical_address"])
        if not re.match(r'^[IQM]', address, re.IGNORECASE):
            warnings.append(
                f'{entry["name"]}: Logical Address {entry["logical_address"]!r} '
                f"isn't a physical I/Q/M address -- skipped."
            )
            continue

        tags.append({
            "name": entry["name"],
            "dtype": _DATA_TYPE_MAP[upper_type],
            "address": address,
        })

    tags.sort(key=lambda t: t["name"])
    return tags, warnings


def generate_opcua_node_ids_from_tag_table(file_bytes, namespace=3, path_prefix=None):
    """Parses the same tag table export, but produces candidate OPC UA
    Node IDs instead of S7 addresses -- one per tag, in the form
    "ns=<namespace>;s=<prefix.><Name>". Siemens' S7-1200/1500 OPC UA
    server exposes PLC tags directly under the tag name (no tag-table
    prefix needed by default); pass path_prefix only if your server
    configuration nests them.

    Returns (tags, warnings) -- see parse_tag_table_xlsx's docstring
    for the shape; here "address" is an OPC UA Node ID string, and
    the same "confirm against a live Browse" caveat from
    s7_db_import.generate_opcua_node_ids applies.
    """
    entries, warnings = _extract_entries(file_bytes)

    prefix = f"{path_prefix}." if path_prefix else ""
    tags = [
        {
            "name": entry["name"],
            "dtype": entry["data_type"].upper() or "UNKNOWN",
            "address": f'ns={namespace};s={prefix}{entry["name"]}',
        }
        for entry in entries
    ]
    tags.sort(key=lambda t: t["name"])

    if entries:
        warnings.append(
            "Node IDs assume the PLC's OPC UA server exposes tags by their "
            "tag-table name directly (Siemens S7-1200/1500 default) -- "
            "confirm at least one against a live Browse before trusting the rest."
        )

    return tags, warnings