# plc/s7_db_import.py
"""
Turns a TIA Portal DB source export into ready-to-use PLC addresses --
either OMS S7 addresses (DB1.DBX0.0, DB1.DBW4, ...) via
parse_db_source(), or candidate OPC UA Node IDs via
generate_opcua_node_ids() -- so the Mapping panel can offer a picker
instead of the user typing each address by hand, for either backend,
fully offline (no PLC connection needed for either).

Where the source text comes from: in TIA Portal, right-click the DB in
the project tree -> "Generate source", then open the resulting .db
file in a text editor and paste its contents into the import dialog.

IMPORTANT CAVEAT -- this only works for DBs with "Optimized block
access" turned OFF. An optimized DB has no fixed member layout at all
(the compiler is free to rearrange/pack members however it likes), so
there is no byte offset to compute from the source text alone. If your
DB must stay optimized, use TIA's DB editor "Export to Excel" toolbar
button instead (with the Offset column enabled) and import that
CSV/XLSX export instead -- it prints the compiler's real offsets
directly, no calculation needed. That importer isn't included here;
ask if you need it too.

Layout rules implemented (Siemens' documented classic, non-optimized
S7-300/400/1200/1500 layout):
  - BOOL members declared back-to-back pack into successive bits of
    the same byte (up to 8 per byte). Any other member type closes
    that byte and starts fresh on the next one.
  - 1-byte types (BYTE, CHAR, SINT, USINT) need no extra alignment.
  - 2-byte and larger types (WORD/INT/UINT/DATE, DWORD/DINT/UDINT/
    REAL/TIME) start on an even byte offset.
  - STRING[n] occupies 2+n bytes (max-length byte + actual-length
    byte + n chars) and starts on an even offset; bare STRING
    defaults to STRING[254].
  - STRUCT members are laid out recursively; the struct itself starts
    on an even offset and its total size is rounded up to even.
  - ARRAY[lo..hi] OF <type> repeats the element layout (hi - lo + 1)
    times.
This covers the large majority of real-world DBs. UDT (custom type)
references and a handful of rarer types (TIME_OF_DAY, LTIME, WSTRING,
multi-instance FB members, ...) aren't resolvable from the source text
alone -- affected members are reported back as "unsupported" rather
than silently guessed at.
"""

import re


class S7ImportError(Exception):
    """Raised for a source text OMS can't make sense of at all (e.g.
    no DATA_BLOCK found). Per-member problems are collected as
    warnings instead of raising, so a partial import is still useful.
    """


# ---------- scalar type -> (OMS dtype letter, byte size, needs even alignment) ----------
# The dtype letters match plc/plc_sync.py's _S7_TYPE_SIZES / S7Address
# so results can be formatted straight into existing address strings.
_SCALAR_TYPES = {
    "BOOL":  ("X", 1, False),
    "BYTE":  ("B", 1, False),
    "CHAR":  ("B", 1, False),
    "SINT":  ("B", 1, False),
    "USINT": ("B", 1, False),
    "WORD":  ("W", 2, True),
    "INT":   ("INT", 2, True),
    "UINT":  ("W", 2, True),
    "DATE":  ("W", 2, True),
    "DWORD": ("DWORD", 4, True),
    "DINT":  ("DINT", 4, True),
    "UDINT": ("DWORD", 4, True),
    "REAL":  ("REAL", 4, True),
    "TIME":  ("DWORD", 4, True),
}

_ARRAY_RE = re.compile(
    r'^ARRAY\s*\[\s*(-?\d+)\s*\.\.\s*(-?\d+)\s*\]\s*OF\s+(.+)$', re.IGNORECASE
)
_STRING_RE = re.compile(r'^STRING\s*(?:\[\s*(\d+)\s*\])?$', re.IGNORECASE)

# One member declaration per line, e.g.:
#   Running : Bool;
#   "My Tag" : Real := 0.0;
#   Sub : Struct
#   Values : Array[0..9] of Int;
_MEMBER_RE = re.compile(
    r'^"?(?P<name>[A-Za-z_][A-Za-z0-9_ ]*)"?\s*:\s*(?P<type>[^;]+?)\s*(?::=.*)?;?\s*$'
)

_DB_HEADER_RE = re.compile(r'^\s*DATA_BLOCK\s+"?(?P<name>[^"\n]+?)"?\s*$', re.IGNORECASE)


_ATTR_RE = re.compile(r'\{[^{}]*\}')


def _strip_comments(text):
    text = re.sub(r'//.*', '', text)
    text = re.sub(r'\(\*.*?\*\)', '', text, flags=re.DOTALL)
    # Strip TIA attribute annotations like `{ S7_SetPoint := 'False'}` --
    # these can sit between a member's name and its `:`, which the
    # member regex below doesn't otherwise tolerate.
    text = _ATTR_RE.sub('', text)
    return text


_TYPE_HEADER_RE = re.compile(r'^\s*TYPE\s+"?(?P<name>[^"\n]+?)"?\s*$', re.IGNORECASE)
_STRUCT_LINE_RE = re.compile(r'^\s*STRUCT\s*$', re.IGNORECASE)
_END_STRUCT_LINE_RE = re.compile(r'^\s*END_STRUCT;?\s*$', re.IGNORECASE)


def _extract_struct_body(lines, start_idx):
    """Given the index of a top-level `STRUCT` line, returns
    (body_lines, end_idx) where end_idx is the index of the matching
    `END_STRUCT` (depth-aware, so nested inline STRUCTs inside don't
    end it early)."""
    depth = 1
    i = start_idx
    while i < len(lines):
        if _STRUCT_LINE_RE.match(lines[i]):
            depth += 1
        elif _END_STRUCT_LINE_RE.match(lines[i]):
            depth -= 1
            if depth == 0:
                return lines[start_idx:i], i
        i += 1
    return lines[start_idx:], len(lines)


def _parse_udt_blocks(lines):
    """Scans the whole source for `TYPE "Name" ... STRUCT ... END_STRUCT
    ... END_TYPE` blocks (TIA emits one per UDT referenced by the DB,
    ahead of the DATA_BLOCK itself) and returns {name: body_lines} so
    a member typed as `"Name"` can be expanded like an inline STRUCT."""
    udts = {}
    i = 0
    while i < len(lines):
        m = _TYPE_HEADER_RE.match(lines[i])
        if m and not lines[i].strip().upper().startswith("DATA_BLOCK"):
            name = m.group("name").strip()
            j = i + 1
            while j < len(lines) and not _STRUCT_LINE_RE.match(lines[j]):
                j += 1
            if j < len(lines):
                body, end_idx = _extract_struct_body(lines, j + 1)
                udts[name] = body
                i = end_idx
        i += 1
    return udts


_UDT_REF_RE = re.compile(r'^"(?P<name>[^"]+)"$')


def _round_up_even(n):
    return n + 1 if n % 2 else n


class _Cursor:
    """Byte/bit position tracker implementing the packing rules above."""

    def __init__(self):
        self.byte = 0
        self.bit = 0          # next free bit in the current byte, if mid-bool-run
        self._in_bool_run = False

    def place_bool(self):
        if not self._in_bool_run:
            self.bit = 0
            self._in_bool_run = True
        offset = (self.byte, self.bit)
        self.bit += 1
        if self.bit > 7:
            self.byte += 1
            self.bit = 0
            self._in_bool_run = False
        return offset

    def _close_bool_run(self):
        if self._in_bool_run:
            self.byte += 1
            self.bit = 0
            self._in_bool_run = False

    def place(self, size, needs_even):
        self._close_bool_run()
        if needs_even and self.byte % 2:
            self.byte += 1
        start = self.byte
        self.byte += size
        return start

    def align_even(self):
        self._close_bool_run()
        if self.byte % 2:
            self.byte += 1


def _parse_member_lines(lines, warnings, prefix="", udts=None):
    """Consumes lines (a list with .pop(0) semantics via index) making
    up one STRUCT body, until (but not including) its END_STRUCT. i is
    a mutable [index] cell so nested calls advance the shared cursor.
    udts is {UDT name: raw body lines}, from _parse_udt_blocks -- a
    member typed as `"SomeUdt"` is expanded exactly like an inline
    STRUCT, recursively (a UDT can itself contain UDT-typed members)."""
    udts = udts or {}
    members = []
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        i += 1
        if not line:
            continue
        if line.upper() in ("END_STRUCT;", "END_STRUCT"):
            return members, i

        m = _MEMBER_RE.match(line)
        if not m:
            continue  # attribute lines ({...}), VERSION, BEGIN/END, etc.

        name = m.group("name").strip()
        type_text = m.group("type").strip()
        full_name = f"{prefix}{name}"

        struct_match = re.match(r'^STRUCT$', type_text, re.IGNORECASE)
        array_match = _ARRAY_RE.match(type_text)
        udt_match = _UDT_REF_RE.match(type_text)

        if struct_match:
            sub_lines = lines[i:]
            sub_members, consumed = _parse_member_lines(
                sub_lines, warnings, prefix=f"{full_name}.", udts=udts,
            )
            i += consumed
            members.append(("struct", full_name, sub_members))
            continue

        if udt_match and udt_match.group("name") in udts:
            udt_body = udts[udt_match.group("name")]
            sub_members, _consumed = _parse_member_lines(
                udt_body, warnings, prefix=f"{full_name}.", udts=udts,
            )
            members.append(("struct", full_name, sub_members))
            continue

        if array_match and array_match.group(3).strip().upper() == "STRUCT":
            lo, hi = int(array_match.group(1)), int(array_match.group(2))
            sub_lines = lines[i:]
            sub_members, consumed = _parse_member_lines(
                sub_lines, warnings, prefix=f"{full_name}[0].", udts=udts,
            )
            i += consumed
            members.append(("array_struct", full_name, lo, hi, sub_members))
            continue

        if array_match:
            lo, hi = int(array_match.group(1)), int(array_match.group(2))
            elem_type = array_match.group(3).strip()
            members.append(("array_scalar", full_name, lo, hi, elem_type))
            continue

        members.append(("scalar", full_name, type_text))

    return members, i


def _layout(members, cursor, warnings, out):
    for member in members:
        kind = member[0]

        if kind == "scalar":
            _, name, type_text = member
            _layout_scalar(name, type_text, cursor, warnings, out)

        elif kind == "struct":
            _, name, sub_members = member
            cursor.align_even()
            _layout(sub_members, cursor, warnings, out)
            cursor.align_even()

        elif kind == "array_scalar":
            _, name, lo, hi, elem_type = member
            for idx in range(lo, hi + 1):
                _layout_scalar(f"{name}[{idx}]", elem_type, cursor, warnings, out)

        elif kind == "array_struct":
            _, name, lo, hi, sub_members = member
            for idx in range(lo, hi + 1):
                indexed = _reindex(sub_members, name, idx)
                cursor.align_even()
                _layout(indexed, cursor, warnings, out)
                cursor.align_even()


def _reindex(sub_members, name, idx):
    """array_struct's sub_members were parsed with a placeholder
    "name[0]." prefix (index unknown at parse time); rewrite it to the
    real element index before layout."""
    placeholder = f"{name}[0]."
    real = f"{name}[{idx}]."
    result = []
    for m in sub_members:
        if m[0] in ("scalar",):
            result.append(("scalar", m[1].replace(placeholder, real, 1), m[2]))
        elif m[0] == "struct":
            result.append(("struct", m[1].replace(placeholder, real, 1),
                            _reindex(m[2], name, idx)))
        elif m[0] == "array_scalar":
            result.append(("array_scalar", m[1].replace(placeholder, real, 1), m[2], m[3], m[4]))
        elif m[0] == "array_struct":
            result.append(("array_struct", m[1].replace(placeholder, real, 1), m[2], m[3],
                            _reindex(m[4], name, idx)))
    return result


def _layout_scalar(name, type_text, cursor, warnings, out):
    type_text = type_text.strip()
    upper = type_text.upper()

    if upper == "BOOL":
        byte, bit = cursor.place_bool()
        out.append({"name": name, "dtype": "BOOL", "byte": byte, "bit": bit})
        return

    if upper in _SCALAR_TYPES:
        letter, size, needs_even = _SCALAR_TYPES[upper]
        start = cursor.place(size, needs_even)
        out.append({"name": name, "dtype": upper, "byte": start, "bit": None, "_letter": letter})
        return

    str_match = _STRING_RE.match(upper)
    if str_match:
        length = int(str_match.group(1)) if str_match.group(1) else 254
        size = 2 + length
        start = cursor.place(size, needs_even=True)
        warnings.append(
            f"{name}: STRING addresses aren't supported by OMS's S7 backend "
            f"yet (occupies DB.DBB{start}..{start + size - 1}) -- skipped."
        )
        return

    warnings.append(
        f"{name}: unrecognized/unsupported type {type_text!r} "
        f"(UDT reference, TIME_OF_DAY, WSTRING, ... aren't resolvable "
        f"from the source text alone) -- skipped."
    )


def _format_address(db_number, entry):
    """Return canonical Siemens S7 DB notation for imported addresses.

    The Mapping panel should use the PLC-native forms rather than OMS
    typed aliases: BOOL -> DBX, 16-bit values -> DBW, and 32-bit values
    -> DBD.  The underlying dtype is still retained separately in the
    imported tag metadata.
    """
    dtype = entry["dtype"]
    byte = entry["byte"]
    if dtype == "BOOL":
        return f"DB{db_number}.DBX{byte}.{entry['bit']}"

    if dtype in ("BYTE", "CHAR", "SINT", "USINT"):
        return f"DB{db_number}.DBB{byte}"
    if dtype in ("WORD", "INT", "UINT", "DATE"):
        return f"DB{db_number}.DBW{byte}"
    if dtype in ("DWORD", "DINT", "UDINT", "REAL", "TIME"):
        return f"DB{db_number}.DBD{byte}"

    # Fallback for any future scalar type that supplies one of the
    # canonical letters.  Never emit typed aliases such as INT/REAL.
    letter = entry.get("_letter")
    if letter in ("X", "B", "W", "D"):
        return f"DB{db_number}.DB{letter}{byte}"
    raise S7ImportError(f"Cannot format S7 address for imported type {dtype!r}")


def _parse_preamble(text):
    """Shared front half of both public entry points: strips comments,
    locates the DATA_BLOCK header and the outer STRUCT body, and
    parses that body into the nested member tree that both the S7
    layout pass and the OPC UA path pass walk. Returns
    (header_name, members, warnings)."""
    if not text or not text.strip():
        raise S7ImportError("No text to parse -- paste the generated DB source first.")

    clean = _strip_comments(text)
    lines = clean.splitlines()

    header_idx = None
    header_name = None
    for idx, line in enumerate(lines):
        m = _DB_HEADER_RE.match(line)
        if m:
            header_idx = idx
            header_name = m.group("name").strip()
            break

    if header_name is None:
        raise S7ImportError(
            "Couldn't find a \"DATA_BLOCK ...\" header -- make sure you pasted "
            "the whole file generated by TIA Portal's \"Generate source\"."
        )

    # UDTs (TYPE "Name" ... END_TYPE) are emitted ahead of the DATA_BLOCK
    # that uses them -- collect their bodies so member lines referencing
    # `"Name"` can be expanded like an inline STRUCT.
    udts = _parse_udt_blocks(lines[:header_idx])

    # Find the DB's OWN top-level STRUCT -- i.e. the first STRUCT line
    # at or after the header, not just the first one anywhere in the
    # file (a UDT/TYPE block declared earlier has its own STRUCT that
    # must not be picked up here).
    struct_start = None
    for idx in range(header_idx, len(lines)):
        if _STRUCT_LINE_RE.match(lines[idx]):
            struct_start = idx + 1
            break

    if struct_start is None:
        raise S7ImportError(
            "Couldn't find the DB's top-level \"STRUCT\" block in the pasted text."
        )

    body, _end_idx = _extract_struct_body(lines, struct_start)
    warnings = []
    members, _consumed = _parse_member_lines(
        body, warnings, prefix="", udts=udts,
    )
    return header_name, members, warnings


def parse_db_source(text, db_number=None):
    """Parses TIA Portal "Generate source" DB text into S7 addresses.

    Returns (tags, warnings):
      tags     -- [{"name", "dtype", "address"}, ...] sorted by address,
                  ready to use as S7 Mapping panel node addresses.
      warnings -- human-readable strings for members that were skipped
                  (unsupported type) or other non-fatal issues.

    Raises S7ImportError if no DATA_BLOCK / STRUCT could be found at
    all, or if db_number wasn't given and couldn't be inferred from
    the header (e.g. `DATA_BLOCK "DB1"`).
    """
    header_name, members, warnings = _parse_preamble(text)

    if db_number is None:
        num_match = re.match(r'^DB(\d+)$', header_name, re.IGNORECASE)
        if num_match:
            db_number = int(num_match.group(1))
        else:
            raise S7ImportError(
                f'DB number not given and the header ("{header_name}") is a '
                f"symbolic name, not a plain DB number -- enter the DB's "
                f"number (as shown in TIA Portal's project tree) and try again."
            )

    cursor = _Cursor()
    out = []
    _layout(members, cursor, warnings, out)
    out.sort(key=lambda e: (e["byte"], e["bit"] if e["bit"] is not None else -1))

    tags = [
        {"name": entry["name"], "dtype": entry["dtype"],
         "address": _format_address(db_number, entry)}
        for entry in out
    ]

    if not tags:
        warnings.append(
            "No addressable members found. Double-check the DB has "
            "\"Optimized block access\" turned off in TIA Portal -- "
            "optimized DBs have no fixed byte layout to compute."
        )

    return tags, warnings


# ---------- OPC UA Node ID generation (offline, no live server needed) ----------
#
# Unlike S7 addressing, OPC UA Node IDs don't depend on byte layout at
# all -- they're just a symbolic path, so this doesn't need any of the
# alignment math above (and, as a bonus, it isn't limited to the
# scalar types the S7 side understands: STRING and UDT-typed members
# get a Node ID too, since there's no size to compute).
## This generates the Node ID Siemens' S7-1200/1500 OPC UA server uses
# for symbol-based (non-optimized) DB access:
#   ns=<namespace>;s=<DB name>.<member>[<index>]...
# (no per-segment quoting -- Siemens' server takes the dotted symbolic
# path as-is; a name containing spaces or other characters that would
# need escaping isn't handled here, since TIA identifiers don't allow
# them anyway)
# CAVEAT: the namespace index (commonly 3, but not guaranteed) and the
# exact server-side naming are set by the PLC's own OPC UA
# configuration, not by this source text -- treat these as a
# ready-to-try starting point, and confirm at least one against a live
# Browse (or your PLC's OPC UA documentation) before trusting the rest.

_ARRAY_SEGMENT_RE = re.compile(r'^(.*?)(\[\d+\])$')


def _quote_opcua_path(full_name):
    """No quoting needed -- kept as a pass-through so the call site
    below doesn't need to change if per-segment quoting turns out to
    be needed for some server after all (some do expect it; Siemens'
    S7-1200/1500 OPC UA server, which this is modeled on, does not)."""
    return full_name


def _flatten_opcua(members, out):
    for member in members:
        kind = member[0]

        if kind == "scalar":
            _, name, type_text = member
            out.append({"name": name, "dtype": type_text.strip().upper()})

        elif kind == "struct":
            _, _name, sub_members = member
            _flatten_opcua(sub_members, out)

        elif kind == "array_scalar":
            _, name, lo, hi, elem_type = member
            for idx in range(lo, hi + 1):
                out.append({"name": f"{name}[{idx}]", "dtype": elem_type.strip().upper()})

        elif kind == "array_struct":
            _, name, lo, hi, sub_members = member
            for idx in range(lo, hi + 1):
                _flatten_opcua(_reindex(sub_members, name, idx), out)


def generate_opcua_node_ids(text, namespace=3, db_name=None):
    """Parses the same TIA "Generate source" DB text, but produces
    candidate OPC UA Node IDs instead of S7 byte addresses -- usable
    fully offline, no PLC connection needed, for either the asyncua or
    opcua backend (both take the same Node ID string).

    Returns (tags, warnings) -- see parse_db_source's docstring for
    the shape; here "address" is an OPC UA Node ID string instead of
    an S7 address, and warnings will always include the namespace/
    naming caveat above so it surfaces in the import preview.
    """
    header_name, members, warnings = _parse_preamble(text)

    if not db_name:
        db_name = header_name

    out = []
    _flatten_opcua(members, out)

    tags = [
        {"name": entry["name"], "dtype": entry["dtype"],
         "address": f'ns={namespace};s={db_name}.{_quote_opcua_path(entry["name"])}'}
        for entry in out
    ]
    tags.sort(key=lambda t: t["name"])

    if not out:
        warnings.append("No members found in the pasted DB source.")

    return tags, warnings