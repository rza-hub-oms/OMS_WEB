import unittest

from plc.s7_db_import import parse_db_source


class S7DbImportTests(unittest.TestCase):
    def test_uses_canonical_siemens_db_addresses(self):
        source = """
DATA_BLOCK "DB1"
STRUCT
    BitTag : Bool;
    WordTag : Int;
    RealTag : Real;
END_STRUCT;
BEGIN
END_DATA_BLOCK
"""
        tags, warnings = parse_db_source(source)
        self.assertEqual(warnings, [])
        self.assertEqual(
            [tag["address"] for tag in tags],
            ["DB1.DBX0.0", "DB1.DBW2", "DB1.DBD4"],
        )

    def test_canonical_addresses_for_other_16_and_32_bit_types(self):
        source = """
DATA_BLOCK "DB1"
STRUCT
    W : Word;
    D : DInt;
    F : Real;
END_STRUCT;
BEGIN
END_DATA_BLOCK
"""
        tags, _ = parse_db_source(source)
        self.assertEqual(
            [tag["address"] for tag in tags],
            ["DB1.DBW0", "DB1.DBD2", "DB1.DBD6"],
        )


if __name__ == "__main__":
    unittest.main()
